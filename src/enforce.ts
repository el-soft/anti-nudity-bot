// Carrying out a decision, and saying so in the log.
//
// Everything here runs after Telegram has had its 200, so a failure cannot be
// signalled back. The audit line is written from what the API actually returned,
// not from what was intended — an `enforced` line means the call succeeded.

import type { Decision } from "./policy.ts";
import type { Context } from "./context.ts";
import { error, info, warn } from "./log.ts";

/**
 * A sliding hour of removals. Best-effort circuit breaker: an edge isolate is
 * short-lived and there are several at once, so this is a brake and not a
 * guarantee. It stops a runaway loop inside one isolate, which is the failure
 * this bot can actually have; a raid across isolates is the operator's call.
 */
export class RemovalBudget {
  #limit: number;
  #spent: number[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  available(): boolean {
    const cutoff = Date.now() - 3_600_000;
    while (this.#spent.length > 0 && this.#spent[0] < cutoff) this.#spent.shift();
    return this.#spent.length < this.#limit;
  }

  spend(): void {
    this.#spent.push(Date.now());
  }
}

export async function enforce(context: Context, decision: Decision): Promise<void> {
  const { action, reason, chatId, userId } = decision;

  if (action === "none") {
    info({ event: "allowed", reason, chat_id: chatId, user_id: userId });
    return;
  }

  if (context.config.dryRun) {
    info({ event: "dry_run", action, reason, chat_id: chatId, user_id: userId });
    return;
  }

  if (action === "remove" && !context.budget.available()) {
    error({
      event: "budget_exhausted",
      detail: "removal budget for this hour is spent; nothing removed",
      limit: context.config.maxRemovalsPerHour,
      chat_id: chatId,
      user_id: userId,
    });
    return;
  }

  if (action === "decline_join_request") {
    const result = await context.client.declineChatJoinRequest(chatId, userId);
    if (!result.ok) {
      warn({ event: "action_failed", action, chat_id: chatId, user_id: userId, ...why(result) });
      return;
    }
    info({ event: "enforced", action, reason, chat_id: chatId, user_id: userId });
    return;
  }

  // Removal is a ban followed by an unban. The ban is what ejects them; the
  // unban is what keeps "removed" from meaning "blacklisted", so a member can
  // still add them deliberately later.
  const banned = await context.client.banChatMember(chatId, userId);
  if (!banned.ok) {
    warn({
      event: "action_failed",
      action,
      detail: "ban failed; the account is still in the chat",
      chat_id: chatId,
      user_id: userId,
      ...why(banned),
    });
    return;
  }
  context.budget.spend();

  const unbanned = await context.client.unbanChatMember(chatId, userId);
  if (!unbanned.ok) {
    // Out of the chat either way, which is the point — but they cannot be
    // re-added until someone lifts the ban, so this is not a quiet failure.
    warn({
      event: "unban_failed",
      detail: "account is out, but stays banned and cannot be re-added",
      chat_id: chatId,
      user_id: userId,
      ...why(unbanned),
    });
  }

  info({ event: "enforced", action, reason, chat_id: chatId, user_id: userId });
}

/** The parts of a failed call worth logging. Never includes the token. */
function why(result: { error: string; errorCode?: number }): Record<string, unknown> {
  return { error: result.error, error_code: result.errorCode };
}
