// Who is allowed to be in the chat. Pure, and unit-tested: getting this wrong is
// how the bot removes someone a member deliberately invited.
//
// The rule, in one line: an account has to have been let in by somebody. A
// member adding them counts, an admin approving a request counts, and an invite
// link counts unless the operator says otherwise. Walking in unaided does not.

import type { Event } from "./classify.ts";
import type { Config } from "./config.ts";

export type Action =
  /** Leave it alone. */
  | "none"
  /** Ban and immediately unban: out of the chat, and re-addable by a member. */
  | "remove"
  /** declineChatJoinRequest. */
  | "decline_join_request";

export interface Decision {
  action: Action;
  /** Goes in the audit line verbatim, so it has to read as a reason on its own. */
  reason: string;
  chatId: number;
  userId: number;
}

function none(event: Event, reason: string): Decision {
  return { action: "none", reason, chatId: event.chatId ?? 0, userId: event.userId ?? 0 };
}

/**
 * `selfId` is the bot's own account. Two separate exemptions depend on it: the
 * bot is never its own subject, and an update the bot itself caused is never
 * acted on again — without that second one, removing an account produces a
 * membership update that the policy would answer by removing them again.
 */
export function decide(event: Event, config: Config, selfId: number | null): Decision {
  if (event.chatId === null) return none(event, "no_chat");
  if (!config.allowedChatIds.has(event.chatId)) return none(event, "chat_not_whitelisted");

  if (event.messageType === "join_request") {
    if (event.userId === null) return none(event, "no_user");
    if (config.exemptUserIds.has(event.userId)) return none(event, "exempt_user");
    if (config.joinRequestAction === "ignore") return none(event, "join_requests_left_to_admins");
    return {
      action: "decline_join_request",
      reason: "join_request_declined_by_policy",
      chatId: event.chatId,
      userId: event.userId,
    };
  }

  const membership = event.membership;
  if (!membership) return none(event, "not_a_membership_change");
  if (membership.route === undefined) return none(event, `not_a_join:${membership.to}`);

  if (selfId !== null && membership.userId === selfId) return none(event, "self");
  if (selfId !== null && membership.actorId === selfId) return none(event, "own_action");
  if (config.exemptUserIds.has(membership.userId)) return none(event, "exempt_user");
  // An account that lands as an admin was made one by somebody with the right to
  // do it, and removing it would be a fight the bot cannot win.
  if (membership.privileged) return none(event, "privileged");

  const remove = (reason: string): Decision => ({
    action: "remove",
    reason,
    chatId: event.chatId as number,
    userId: membership.userId,
  });

  switch (membership.route) {
    case "added_by_member":
      return none(event, "added_by_member");
    case "join_request":
      return none(event, "approved_by_admin");
    case "invite_link":
      return config.allowInviteLinkJoins
        ? none(event, "invite_link_allowed")
        : remove("joined_by_invite_link");
    case "chat_folder":
      return config.allowInviteLinkJoins
        ? none(event, "chat_folder_link_allowed")
        : remove("joined_by_chat_folder_link");
    case "unaided":
      // Nobody let them in: no link, no adder, no approval. This is the case the
      // rule exists for.
      return remove("joined_unaided");
    case "undisclosed":
      // A service-message join. In a supergroup the same join also arrives as a
      // `chat_member` update carrying the real route, and that one is what gets
      // acted on; acting here as well would remove invited people whose link
      // the service message simply does not mention.
      return config.removeUndisclosedJoins
        ? remove("joined_by_undisclosed_route")
        : none(event, "route_undisclosed");
  }
}
