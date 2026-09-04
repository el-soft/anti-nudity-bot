// update -> who should be scanned. Pure, and unit-tested: getting this wrong is
// how the bot bans the wrong account.

import type { ChatMemberUpdated, Message, Update, User } from "./types.ts";

export type Trigger =
  | "join"
  | "join_request"
  | "message"
  | "edited_message"
  | "forward"
  /** An admin ran /scan. Tagged separately so a manual sweep is distinguishable
   * from the bot acting on its own in the audit log. */
  | "scan_command";

/** An account the bot might scan, plus what it is allowed to do about it. */
export interface Subject {
  userId: number;
  isBot: boolean;
  /** True when the account is a member of this chat, so it can be banned here. */
  actionable: boolean;
  role: "joiner" | "sender" | "forward_origin";
}

export interface Routed {
  kind:
    | "join"
    | "join_request"
    | "message"
    | "my_chat_member"
    | "drop";
  reason?: string;
  chatId: number;
  trigger?: Trigger;
  message?: Message;
  subjects: Subject[];
  /** The join notice / offending message, for deletion. */
  messageId: number | null;
  chatMember?: ChatMemberUpdated;
  joinedAt?: number;
}

const PRESENT = new Set(["member", "restricted"]);
const ABSENT = new Set(["left", "kicked"]);

function drop(chatId: number, reason: string): Routed {
  return { kind: "drop", reason, chatId, subjects: [], messageId: null };
}

/** True for the service messages the bot has no opinion about. */
function isUninterestingService(message: Message): boolean {
  return Boolean(
    message.left_chat_member ||
      message.new_chat_title ||
      message.new_chat_photo ||
      message.pinned_message ||
      message.group_chat_created,
  );
}

export function route(update: Update, selfId: number | null): Routed {
  if (update.my_chat_member) {
    return {
      kind: "my_chat_member",
      chatId: update.my_chat_member.chat.id,
      subjects: [],
      messageId: null,
      chatMember: update.my_chat_member,
    };
  }

  if (update.chat_join_request) {
    const request = update.chat_join_request;
    return {
      kind: "join_request",
      chatId: request.chat.id,
      trigger: "join_request",
      messageId: null,
      joinedAt: request.date,
      subjects: [{
        userId: request.from.id,
        isBot: Boolean(request.from.is_bot),
        // Not in the chat yet: the action is decline, never ban.
        actionable: false,
        role: "joiner",
      }],
    };
  }

  if (update.chat_member) {
    const event = update.chat_member;
    const was = event.old_chat_member.status;
    const now = event.new_chat_member.status;
    // Only an absent -> present transition is a join. Promotions, demotions,
    // restrictions and departures are all somebody else's business.
    if (!(ABSENT.has(was) && PRESENT.has(now))) {
      return drop(event.chat.id, `membership_transition:${was}->${now}`);
    }
    const user = event.new_chat_member.user;
    if (selfId !== null && user.id === selfId) return drop(event.chat.id, "self_join");
    return {
      kind: "join",
      chatId: event.chat.id,
      trigger: "join",
      messageId: null,
      joinedAt: event.date,
      chatMember: event,
      subjects: [{
        userId: user.id,
        isBot: Boolean(user.is_bot),
        actionable: true,
        role: "joiner",
      }],
    };
  }

  const message = update.message ?? update.edited_message;
  if (!message) return drop(0, "unhandled_update_type");

  if (message.new_chat_members?.length) {
    // Fallback join path. One service message can add several accounts, and each
    // is scanned independently.
    const subjects = message.new_chat_members
      .filter((user) => selfId === null || user.id !== selfId)
      .map((user): Subject => ({
        userId: user.id,
        isBot: Boolean(user.is_bot),
        actionable: true,
        role: "joiner",
      }));
    if (subjects.length === 0) return drop(message.chat.id, "self_join");
    return {
      kind: "join",
      chatId: message.chat.id,
      trigger: "join",
      message,
      messageId: message.message_id,
      joinedAt: message.date,
      subjects,
    };
  }

  if (isUninterestingService(message)) {
    return drop(message.chat.id, "service_message");
  }

  // Anonymous admin posts and channel auto-forwards have no actionable member
  // behind them.
  if (message.sender_chat) return drop(message.chat.id, "sender_chat");
  if (message.is_automatic_forward) return drop(message.chat.id, "automatic_forward");
  if (!message.from) return drop(message.chat.id, "no_sender");
  if (selfId !== null && message.from.id === selfId) return drop(message.chat.id, "own_message");

  const subjects: Subject[] = [{
    userId: message.from.id,
    isBot: Boolean(message.from.is_bot),
    actionable: true,
    role: "sender",
  }];

  const origin = forwardOriginUser(message);
  if (origin && origin.id !== message.from.id) {
    subjects.push({
      userId: origin.id,
      isBot: Boolean(origin.is_bot),
      // The original author is usually not a member of this chat, so a ban here
      // would be meaningless. FORWARD_ORIGIN_ACTION decides what a bad origin
      // costs the member who forwarded it.
      actionable: false,
      role: "forward_origin",
    });
  }

  return {
    kind: "message",
    chatId: message.chat.id,
    trigger: update.edited_message ? "edited_message" : "message",
    message,
    messageId: message.message_id,
    joinedAt: undefined,
    subjects,
  };
}

/**
 * The original author of a forward, when Telegram discloses one.
 *
 * `hidden_user` is the deliberate hole: Telegram withholds the user_id when the
 * author has account-linking disabled, and there is no Bot API route around it.
 */
export function forwardOriginUser(message: Message): User | null {
  const origin = message.forward_origin;
  if (!origin) return null;
  if (origin.type === "user") return origin.sender_user;
  return null;
}

export function forwardOriginUnresolvable(message: Message): boolean {
  return message.forward_origin?.type === "hidden_user";
}
