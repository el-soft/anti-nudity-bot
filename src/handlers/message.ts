// Trigger 2 — a user posted. Both tracks run.
//
// Track B on every message is what makes the bot work in a group it was added to
// mid-life, and what catches an account that changed its avatar after joining.
// The verdict cache is what makes that affordable: in steady state a message from
// an established member is one cache lookup.

import type { Context } from "../context.ts";
import { actOnMessageMedia, enforce } from "../enforce/actions.ts";
import { info } from "../log.ts";
import { forwardOriginUnresolvable, type Routed } from "../telegram/subjects.ts";
import { scanMessageMedia } from "../tracks/media.ts";
import { checkAccount } from "./common.ts";

export async function handleMessage(context: Context, routed: Routed): Promise<void> {
  const { config, client } = context;
  const message = routed.message!;
  const trigger = routed.trigger ?? "message";

  if (forwardOriginUnresolvable(message)) {
    // Telegram withholds the user_id when the original author has account
    // linking disabled. There is no Bot API route around it; only the forwarder
    // can be scanned.
    info({
      event: "origin_unresolvable",
      chat_id: routed.chatId,
      message_id: routed.messageId,
    });
  }

  // --- Track B: the sender ------------------------------------------------
  const sender = routed.subjects.find((subject) => subject.role === "sender");
  let senderBanned = false;
  if (sender) {
    const outcome = await checkAccount(context, sender, {
      trigger,
      chatId: routed.chatId,
      messageId: routed.messageId,
    });
    senderBanned = outcome.banned;
  }

  // --- Track B: the original author of a forward --------------------------
  const origin = routed.subjects.find((subject) => subject.role === "forward_origin");
  if (origin && !senderBanned && config.forwardOriginAction !== "ignore") {
    const outcome = await checkAccount(context, origin, {
      trigger: "forward",
      chatId: routed.chatId,
      messageId: null,
    });

    if (outcome.flagged && routed.messageId !== null) {
      if (config.forwardOriginAction === "delete_and_ban" && sender) {
        // Forwarding content from a flagged account counts as the forwarder's
        // own violation.
        await enforce(client, config, {
          chatId: routed.chatId,
          userId: sender.userId,
          trigger: "forward",
          finding: {
            reason: "profile_nsfw",
            score: null,
            className: null,
            photoFileUniqueId: null,
            matchedDomain: null,
          },
          messageId: routed.messageId,
        });
        senderBanned = true;
      } else if (!config.dryRun) {
        // Default: delete the message, leave the forwarder alone — a member may
        // be forwarding spam precisely in order to complain about it.
        const deleted = await client.deleteMessage(routed.chatId, routed.messageId);
        info({
          event: "forward_origin_action",
          chat_id: routed.chatId,
          message_id: routed.messageId,
          action: "delete",
          result: deleted.ok ? "ok" : deleted.error,
        });
      }
    }
  }

  // --- Track A: the attached image ----------------------------------------
  const scan = await scanMessageMedia(client, config, message);
  if (scan.skipped === "no_media") return;

  info({
    event: "verdict",
    chat_id: routed.chatId,
    message_id: routed.messageId,
    user_id: sender?.userId ?? null,
    trigger,
    track: "A",
    flagged: scan.flagged,
    score: scan.score,
    class: scan.className,
    file_unique_id: scan.fileUniqueId,
    skipped: scan.skipped,
    action: !scan.flagged ? "none" : senderBanned ? "suppressed" : config.messageAction,
    ms: scan.ms,
    dry_run: config.dryRun,
  });

  if (!scan.flagged || routed.messageId === null) return;

  // No point warning about a photo posted by an account that is being removed —
  // the ban's revoke_messages already took the message with it.
  if (senderBanned) return;

  // Opt-in: message content can also remove the account. Not the default, because
  // a single bad photo can be a mistake or a forward, whereas an explicit avatar
  // is what the account IS.
  if (config.enforcementReasons.has("message_nsfw") && sender) {
    await enforce(client, config, {
      chatId: routed.chatId,
      userId: sender.userId,
      trigger,
      finding: {
        reason: "message_nsfw",
        score: scan.score,
        className: scan.className,
        photoFileUniqueId: scan.fileUniqueId,
        matchedDomain: null,
      },
      messageId: routed.messageId,
    });
    return;
  }

  await actOnMessageMedia(client, config, routed.chatId, routed.messageId);
}
