// The only module that deletes, bans or declines. Everything destructive the bot
// can do goes through `enforce`.

import type { Config, EnforcementReason } from "../config.ts";
import { error, errText, info, warn } from "../log.ts";
import type { TelegramClient } from "../telegram/api.ts";
import type { Trigger } from "../telegram/subjects.ts";
import { reserve } from "./budget.ts";

export interface Finding {
  reason: EnforcementReason;
  score: number | null;
  className: string | null;
  photoFileUniqueId: string | null;
  matchedDomain: string | null;
}

export interface EnforceRequest {
  chatId: number;
  userId: number;
  trigger: Trigger;
  finding: Finding;
  /** The message that exposed the account, or the "X joined" notice. */
  messageId: number | null;
  /** Join requests are declined instead of banned — the account is not in the chat. */
  joinRequest?: boolean;
}

export type ActionOutcome = "ok" | "skipped" | "dry_run" | "expired" | "budget" | string;

export interface EnforceResult {
  enforced: boolean;
  actions: Record<string, ActionOutcome | boolean>;
  budgetRemaining: number;
}

/** True when this finding is one the operator asked to act on. */
export function shouldEnforce(reason: EnforcementReason, config: Config): boolean {
  return config.enforcementReasons.has(reason);
}

export async function enforce(
  client: TelegramClient,
  config: Config,
  request: EnforceRequest,
): Promise<EnforceResult> {
  const { chatId, userId, trigger, finding, messageId } = request;
  const actions: Record<string, ActionOutcome | boolean> = {};

  const budget = await reserve(chatId, config, Date.now());
  let enforced = false;

  if (!budget.allowed) {
    // Past the cap, violations are logged and alerted but not acted on.
    actions.ban = "budget";
    warn({ event: "budget_exceeded", chat_id: chatId, user_id: userId, trigger });
  } else if (config.dryRun) {
    actions.delete = "dry_run";
    actions.ban = "dry_run";
  } else if (request.joinRequest) {
    const declined = await client.declineChatJoinRequest(chatId, userId);
    actions.decline = declined.ok ? "ok" : declined.error;
    enforced = declined.ok;
  } else {
    // Step 1 is not redundant with the revoke: doing it first means the offending
    // message is gone at the earliest possible moment, even if the ban then fails
    // on a permissions error.
    if (messageId !== null) {
      const deleted = await client.deleteMessage(chatId, messageId);
      if (deleted.ok) actions.delete = "ok";
      else if (/too old|message to delete not found/i.test(deleted.error)) {
        actions.delete = "expired";
      } else actions.delete = deleted.error;
    } else {
      actions.delete = "skipped";
    }

    // The ban IS the delete: revoke_messages is the only Bot API route to
    // clearing an account's history, and it is a parameter of banChatMember.
    const chats = config.banScope === "all_chats" ? [...config.allowedChatIds] : [chatId];
    const results: string[] = [];
    for (const target of chats) {
      const banned = await client.banChatMember(target, userId, config.revokeMessages);
      if (banned.ok) {
        results.push("ok");
        enforced = true;
      } else {
        results.push(banned.error);
        if (/administrator|creator|can't remove chat owner/i.test(banned.error)) {
          // Should be unreachable: admins are exempt long before this point.
          // Reaching it means the exemption check is wrong.
          error({
            event: "ban_on_admin",
            chat_id: target,
            user_id: userId,
            error: banned.error,
          });
        }
      }
    }
    actions.ban = results.every((r) => r === "ok") ? "ok" : results.join("; ");
    actions.revoke_messages = config.revokeMessages;
  }

  // The audit line is written whether or not the API calls succeeded — it is the
  // record a human needs to review or reverse a ban, and it must not depend on
  // the ban having worked.
  warn({
    event: "enforcement",
    chat_id: chatId,
    user_id: userId,
    trigger,
    reason: finding.reason,
    score: finding.score,
    class: finding.className,
    photo_file_unique_id: finding.photoFileUniqueId,
    matched_domain: finding.matchedDomain,
    actions,
    budget_remaining: budget.remaining,
    dry_run: config.dryRun,
  });

  if (config.adminAlertChatId !== null) {
    await alert(client, config, request, actions, budget.remaining);
  }

  return { enforced, actions, budgetRemaining: budget.remaining };
}

/** Mirrors an enforcement to a private admin chat, which outlives Netlify's log
 * retention and is where a human goes to reverse a ban. */
async function alert(
  client: TelegramClient,
  config: Config,
  request: EnforceRequest,
  actions: Record<string, ActionOutcome | boolean>,
  budgetRemaining: number,
): Promise<void> {
  const { finding } = request;
  const lines = [
    config.dryRun ? "🧪 DRY RUN — would have enforced" : "🚫 Enforcement",
    `chat: ${request.chatId}`,
    `user: ${request.userId}`,
    `trigger: ${request.trigger}`,
    `reason: ${finding.reason}`,
    finding.score !== null ? `score: ${finding.score.toFixed(3)} (${finding.className})` : null,
    finding.matchedDomain !== null ? `domain: ${finding.matchedDomain}` : null,
    `actions: ${JSON.stringify(actions)}`,
    `budget remaining this hour: ${budgetRemaining}`,
    `to reverse: unbanChatMember(${request.chatId}, ${request.userId})`,
  ].filter((line): line is string => line !== null);

  try {
    const sent = await client.sendMessage(config.adminAlertChatId!, lines.join("\n"));
    if (!sent.ok) warn({ event: "alert_failed", error: sent.error });
  } catch (e) {
    warn({ event: "alert_failed", error: errText(e) });
  }
}

/** Track A's action on a flagged message image. Never a ban. */
export async function actOnMessageMedia(
  client: TelegramClient,
  config: Config,
  chatId: number,
  messageId: number,
): Promise<Record<string, ActionOutcome>> {
  const actions: Record<string, ActionOutcome> = {};
  if (config.dryRun || config.messageAction === "log") {
    actions.reply = config.dryRun ? "dry_run" : "skipped";
    actions.delete = config.dryRun ? "dry_run" : "skipped";
    return actions;
  }

  if (config.messageAction === "warn" || config.messageAction === "warn_and_delete") {
    const sent = await client.sendMessage(chatId, config.warningMessage, messageId);
    actions.reply = sent.ok ? "ok" : sent.error;
  }
  if (config.messageAction === "delete" || config.messageAction === "warn_and_delete") {
    const deleted = await client.deleteMessage(chatId, messageId);
    actions.delete = deleted.ok ? "ok" : deleted.error;
  }
  info({ event: "message_action", chat_id: chatId, message_id: messageId, actions });
  return actions;
}
