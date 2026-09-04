// The bot's own membership changes: added, promoted, demoted, removed.
//
// Two housekeeping jobs. Verify admin rights the moment the bot is promoted,
// rather than discovering they are missing at the moment of a ban; and optionally
// leave any chat that is not whitelisted.

import type { Context } from "../context.ts";
import { checkOwnRights } from "../enforce/exempt.ts";
import { error, info, warn } from "../log.ts";
import type { Routed } from "../telegram/subjects.ts";

export async function handleMyChatMember(context: Context, routed: Routed): Promise<void> {
  const { config, client } = context;
  const event = routed.chatMember!;
  const status = event.new_chat_member.status;

  info({
    event: "own_status_changed",
    chat_id: routed.chatId,
    status,
    whitelisted: config.allowedChatIds.has(routed.chatId),
  });

  if (!config.allowedChatIds.has(routed.chatId)) {
    // Defence in depth. The whitelist already prevents processing; leaving also
    // stops the bot from accumulating admin rights in groups its operator does
    // not know about — and the bot's username is public, so anyone can add it.
    if (config.leaveUnlistedChats && status !== "left" && status !== "kicked") {
      const left = await client.leaveChat(routed.chatId);
      warn({
        event: "left_unlisted_chat",
        chat_id: routed.chatId,
        result: left.ok ? "ok" : left.error,
      });
    }
    return;
  }

  if (status === "left" || status === "kicked") {
    warn({ event: "removed_from_whitelisted_chat", chat_id: routed.chatId });
    return;
  }

  const selfId = await context.selfId();
  if (selfId === null) return;

  const rights = await checkOwnRights(client, routed.chatId, selfId);
  if (rights.ok) {
    info({ event: "rights_ok", chat_id: routed.chatId });
  } else {
    // Loud, and at promotion time rather than at enforcement time. Missing admin
    // status is also why `chat_member` join updates would never arrive.
    error({ event: "rights_missing", chat_id: routed.chatId, missing: rights.missing });
  }
}
