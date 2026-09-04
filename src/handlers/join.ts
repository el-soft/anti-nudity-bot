// Trigger 1a — a user joined.
//
// The earliest and cheapest place to catch a bad account: it has posted nothing,
// so there is no history to wipe and nothing for members to have seen.

import type { Context } from "../context.ts";
import { debug } from "../log.ts";
import type { Routed } from "../telegram/subjects.ts";
import { checkAccount } from "./common.ts";

export async function handleJoin(context: Context, routed: Routed): Promise<void> {
  const { config } = context;
  if (!config.scanOnJoin) {
    debug({ event: "skipped", reason: "scan_on_join_disabled", chat_id: routed.chatId });
    return;
  }

  // Without this, a ban leaves the chat showing "X joined the group" for an
  // account that no longer exists, which reads as the bot having failed.
  const noticeId = config.deleteJoinNotice ? routed.messageId : null;

  for (const subject of routed.subjects) {
    await checkAccount(context, subject, {
      trigger: "join",
      chatId: routed.chatId,
      messageId: noticeId,
      joinedAt: routed.joinedAt,
    });
  }
}
