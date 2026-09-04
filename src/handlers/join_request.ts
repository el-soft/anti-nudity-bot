// Trigger 1b — a join request, in groups with approval enabled.
//
// Strictly better than scanning at join time, because the account is vetted
// before it is ever in the room: a violation is declined rather than banned, so
// there is nothing to delete and no ban to reverse.

import type { Context } from "../context.ts";
import { debug, info } from "../log.ts";
import type { Routed } from "../telegram/subjects.ts";
import { checkAccount } from "./common.ts";

export async function handleJoinRequest(context: Context, routed: Routed): Promise<void> {
  const { config, client } = context;
  if (!config.scanJoinRequests) {
    debug({ event: "skipped", reason: "scan_join_requests_disabled", chat_id: routed.chatId });
    return;
  }

  const subject = routed.subjects[0];
  if (!subject) return;

  const outcome = await checkAccount(context, subject, {
    trigger: "join_request",
    chatId: routed.chatId,
    messageId: null,
    joinedAt: routed.joinedAt,
    joinRequest: true,
  });

  if (outcome.flagged) return;

  // Deliberately asymmetric: the bot declines on its own judgement but does not
  // auto-approve, so a clean scan does not become an endorsement. Human admins
  // keep the approval decision unless they opt in.
  if (!config.approveCleanJoinRequests) {
    debug({
      event: "join_request_left_for_human",
      chat_id: routed.chatId,
      user_id: subject.userId,
    });
    return;
  }
  if (config.dryRun) {
    info({
      event: "join_request_approve",
      chat_id: routed.chatId,
      user_id: subject.userId,
      dry_run: true,
    });
    return;
  }

  const approved = await client.approveChatJoinRequest(routed.chatId, subject.userId);
  info({
    event: "join_request_approve",
    chat_id: routed.chatId,
    user_id: subject.userId,
    result: approved.ok ? "ok" : approved.error,
    dry_run: false,
  });
}
