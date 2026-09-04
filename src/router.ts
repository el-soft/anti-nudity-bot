// update -> handler. The whitelist gate lives here, so nothing is fetched,
// downloaded or classified for a chat the operator did not name.

import type { Context } from "./context.ts";
import { handleJoin } from "./handlers/join.ts";
import { handleJoinRequest } from "./handlers/join_request.ts";
import { handleMessage } from "./handlers/message.ts";
import { handleMyChatMember } from "./handlers/my_member.ts";
import { debug, error, errText, info } from "./log.ts";
import { route } from "./telegram/subjects.ts";
import type { Update } from "./telegram/types.ts";

/**
 * Everything after the 200 has already gone out. A failure here cannot be
 * signalled to Telegram, which is why enforcement writes its audit record
 * independently of whether the API calls succeeded.
 */
export async function dispatch(context: Context, update: Update): Promise<void> {
  const selfId = await context.selfId();
  const routed = route(update, selfId);

  if (routed.kind === "drop") {
    debug({ event: "skipped", reason: routed.reason, update_id: update.update_id });
    return;
  }

  // my_chat_member is the one update handled for chats *outside* the whitelist,
  // because leaving an unlisted chat is precisely a response to being added to one.
  if (routed.kind !== "my_chat_member" && !context.config.allowedChatIds.has(routed.chatId)) {
    info({
      event: "skipped",
      reason: "chat_not_whitelisted",
      update_id: update.update_id,
      kind: routed.kind,
      chat_id: routed.chatId,
    });
    return;
  }

  try {
    switch (routed.kind) {
      case "join":
        await handleJoin(context, routed);
        break;
      case "join_request":
        await handleJoinRequest(context, routed);
        break;
      case "message":
        await handleMessage(context, routed);
        break;
      case "my_chat_member":
        await handleMyChatMember(context, routed);
        break;
    }
  } catch (e) {
    error({
      event: "handler_failed",
      kind: routed.kind,
      chat_id: routed.chatId,
      update_id: update.update_id,
      error: errText(e),
    });
  }
}
