// update -> one flat record: what kind of update it is, which chat it came from,
// and which account is behind it. Pure and unit-tested; this is the whole bot.

import type { ChatMemberUpdated, Message, Update } from "./telegram/types.ts";

/** How an account came into the chat. The policy turns on exactly this. */
export type JoinRoute =
  /** Walked in unaided: public group, username search, QR. Nobody vouched. */
  | "unaided"
  /** Came in through an invite link, so somebody handed out the link. */
  | "invite_link"
  /** An existing member added them through the member list. */
  | "added_by_member"
  /** An admin approved a join request. */
  | "join_request"
  /** Came in through a shared chat folder. */
  | "chat_folder"
  /** A join seen only as a service message, which carries no link information. */
  | "undisclosed";

/** What a membership update actually changed, for the policy to decide on. */
export interface Membership {
  /** The account the update is about. */
  userId: number;
  /** Who caused the change. Equal to `userId` on a self-service join. */
  actorId: number;
  from: string;
  to: string;
  /** Set on a join; absent on every other transition. */
  route?: JoinRoute;
  /** True when the account is now a member, an admin or the creator. */
  present: boolean;
  /** True when the account is now an admin or the creator. */
  privileged: boolean;
  /** Which update carried it — a service message discloses much less. */
  via: "chat_member" | "my_chat_member" | "service_message";
}

export interface Event {
  /** What happened, e.g. "message.photo", "joined", "reaction". */
  messageType: string;
  /** Null for updates that carry no chat (inline queries, poll updates). */
  chatId: number | null;
  /** Null when the actor is a channel or an anonymous admin, not a user. */
  userId: number | null;
  /** Present when the update is about a specific message. */
  messageId?: number;
  /** `chat.type` when Telegram sends it, for reading the lines later. */
  chatType?: string;
  /** True for a bot account; omitted otherwise. */
  isBot?: boolean;
  /** Extra detail worth a column: the membership transition, the edit flag. */
  detail?: string;
  /** Present on a membership change, for the policy. Never logged as an object. */
  membership?: Membership;
}

/** Presence of one of these names an ordinary message. First match wins. */
const CONTENT: Array<[keyof Message, string]> = [
  ["text", "text"],
  ["photo", "photo"],
  ["sticker", "sticker"],
  ["animation", "animation"],
  ["video", "video"],
  ["video_note", "video_note"],
  ["voice", "voice"],
  ["audio", "audio"],
  ["document", "document"],
  ["paid_media", "paid_media"],
  ["story", "story"],
  ["contact", "contact"],
  ["location", "location"],
  ["venue", "venue"],
  ["poll", "poll"],
  ["dice", "dice"],
  ["game", "game"],
  ["invoice", "invoice"],
];

/** Service messages, which are named instead of being called a message. */
const SERVICE: Array<[keyof Message, string]> = [
  ["new_chat_title", "chat_title_changed"],
  ["new_chat_photo", "chat_photo_changed"],
  ["delete_chat_photo", "chat_photo_deleted"],
  ["pinned_message", "message_pinned"],
  ["group_chat_created", "group_created"],
  ["supergroup_chat_created", "supergroup_created"],
  ["channel_chat_created", "channel_created"],
  ["migrate_to_chat_id", "chat_migrated_to"],
  ["migrate_from_chat_id", "chat_migrated_from"],
  ["successful_payment", "payment_successful"],
  ["refunded_payment", "payment_refunded"],
  ["users_shared", "users_shared"],
  ["chat_shared", "chat_shared"],
  ["write_access_allowed", "write_access_allowed"],
  ["message_auto_delete_timer_changed", "auto_delete_timer_changed"],
  ["boost_added", "boost_added"],
  ["forum_topic_created", "forum_topic_created"],
  ["forum_topic_edited", "forum_topic_edited"],
  ["forum_topic_closed", "forum_topic_closed"],
  ["forum_topic_reopened", "forum_topic_reopened"],
  ["video_chat_scheduled", "video_chat_scheduled"],
  ["video_chat_started", "video_chat_started"],
  ["video_chat_ended", "video_chat_ended"],
  ["video_chat_participants_invited", "video_chat_participants_invited"],
  ["web_app_data", "web_app_data"],
];

const PRESENT = new Set(["creator", "administrator", "member", "restricted"]);
const PRIVILEGED = new Set(["creator", "administrator"]);

export function classify(update: Update): Event[] {
  if (update.message) return fromMessage(update.message, "message");
  if (update.edited_message) return fromMessage(update.edited_message, "edited_message");
  if (update.channel_post) return fromMessage(update.channel_post, "channel_post");
  if (update.edited_channel_post) {
    return fromMessage(update.edited_channel_post, "edited_channel_post");
  }
  if (update.business_message) return fromMessage(update.business_message, "business_message");
  if (update.edited_business_message) {
    return fromMessage(update.edited_business_message, "edited_business_message");
  }

  if (update.deleted_business_messages) {
    const it = update.deleted_business_messages;
    return [{
      messageType: "business_messages_deleted",
      chatId: it.chat.id,
      userId: null,
      chatType: it.chat.type,
      detail: `count=${it.message_ids.length}`,
    }];
  }

  if (update.business_connection) {
    const it = update.business_connection;
    return [{
      messageType: "business_connection",
      chatId: it.user_chat_id,
      userId: it.user.id,
      isBot: it.user.is_bot || undefined,
    }];
  }

  if (update.message_reaction) {
    const it = update.message_reaction;
    return [{
      messageType: "reaction",
      chatId: it.chat.id,
      userId: it.user?.id ?? null,
      messageId: it.message_id,
      chatType: it.chat.type,
      detail: it.user ? undefined : "actor=chat",
    }];
  }

  if (update.message_reaction_count) {
    const it = update.message_reaction_count;
    return [{
      messageType: "reaction_count",
      chatId: it.chat.id,
      userId: null,
      messageId: it.message_id,
      chatType: it.chat.type,
    }];
  }

  if (update.my_chat_member) return [membership(update.my_chat_member, "my_chat_member")];
  if (update.chat_member) return [membership(update.chat_member, "chat_member")];

  if (update.chat_join_request) {
    const it = update.chat_join_request;
    return [{
      messageType: "join_request",
      chatId: it.chat.id,
      userId: it.from.id,
      chatType: it.chat.type,
      isBot: it.from.is_bot || undefined,
    }];
  }

  if (update.callback_query) {
    const it = update.callback_query;
    return [{
      messageType: "callback_query",
      chatId: it.message?.chat?.id ?? null,
      userId: it.from.id,
      messageId: it.message?.message_id,
      chatType: it.message?.chat?.type,
      isBot: it.from.is_bot || undefined,
    }];
  }

  if (update.inline_query) {
    return [{ messageType: "inline_query", chatId: null, userId: update.inline_query.from.id }];
  }

  if (update.chosen_inline_result) {
    return [{
      messageType: "chosen_inline_result",
      chatId: null,
      userId: update.chosen_inline_result.from.id,
    }];
  }

  if (update.shipping_query) {
    return [{ messageType: "shipping_query", chatId: null, userId: update.shipping_query.from.id }];
  }

  if (update.pre_checkout_query) {
    return [{
      messageType: "pre_checkout_query",
      chatId: null,
      userId: update.pre_checkout_query.from.id,
    }];
  }

  if (update.purchased_paid_media) {
    return [{
      messageType: "paid_media_purchased",
      chatId: null,
      userId: update.purchased_paid_media.from.id,
    }];
  }

  if (update.poll_answer) {
    const it = update.poll_answer;
    return [{
      messageType: "poll_answer",
      chatId: it.voter_chat?.id ?? null,
      userId: it.user?.id ?? null,
    }];
  }

  if (update.poll) return [{ messageType: "poll_state", chatId: null, userId: null }];

  if (update.chat_boost) {
    const it = update.chat_boost;
    return [{
      messageType: "chat_boost",
      chatId: it.chat.id,
      userId: it.boost?.source?.user?.id ?? null,
      chatType: it.chat.type,
    }];
  }

  if (update.removed_chat_boost) {
    const it = update.removed_chat_boost;
    return [{
      messageType: "chat_boost_removed",
      chatId: it.chat.id,
      userId: it.source?.user?.id ?? null,
      chatType: it.chat.type,
    }];
  }

  return [{ messageType: "unknown", chatId: null, userId: null }];
}

/**
 * One message can produce several events: a join notice naming three accounts is
 * three joins, because "who joined" is the interesting column.
 */
function fromMessage(message: Message, kind: string): Event[] {
  const base = {
    chatId: message.chat.id,
    messageId: message.message_id,
    chatType: message.chat.type,
  };

  if (message.new_chat_members?.length) {
    const actorId = message.from?.id ?? 0;
    return message.new_chat_members.map((user) => ({
      ...base,
      messageType: "joined",
      userId: user.id,
      isBot: user.is_bot || undefined,
      detail: "via=service_message",
      membership: {
        userId: user.id,
        actorId,
        from: "left",
        to: "member",
        // A service message says who added whom and nothing else: whether a
        // link was involved is simply not in it. `undisclosed` is what keeps
        // the policy from reading that silence as "walked in unaided".
        route: actorId === user.id ? "undisclosed" : "added_by_member",
        present: true,
        privileged: false,
        via: "service_message" as const,
      },
    }));
  }

  if (message.left_chat_member) {
    const user = message.left_chat_member;
    return [{
      ...base,
      messageType: "left",
      userId: user.id,
      isBot: user.is_bot || undefined,
      detail: "via=service_message",
      membership: {
        userId: user.id,
        actorId: message.from?.id ?? 0,
        from: "member",
        to: "left",
        present: false,
        privileged: false,
        via: "service_message" as const,
      },
    }];
  }

  const actor = message.from?.id ?? null;
  const isBot = message.from?.is_bot || undefined;

  for (const [field, name] of SERVICE) {
    if (message[field] !== undefined) {
      return [{ ...base, messageType: name, userId: actor, isBot }];
    }
  }

  // The sender is a channel or an anonymous admin: there is no user behind it,
  // and `sender_chat` is the only identity Telegram discloses.
  const detail: string[] = [];
  if (message.sender_chat) detail.push(`sender_chat=${message.sender_chat.id}`);
  if (message.is_automatic_forward) detail.push("automatic_forward");
  if (message.forward_origin) detail.push(`forward=${message.forward_origin.type}`);
  if (message.reply_to_message) detail.push("reply");

  const content = CONTENT.find(([field]) => message[field] !== undefined)?.[1] ?? "other";

  return [{
    ...base,
    messageType: `${kind}.${content}`,
    userId: actor,
    isBot,
    detail: detail.length > 0 ? detail.join(",") : undefined,
  }];
}

/**
 * A membership update is named by what it actually changed. Telegram sends the
 * same shape for a join, a departure, a promotion and a mute, so the transition
 * is what distinguishes them.
 */
function membership(event: ChatMemberUpdated, kind: "chat_member" | "my_chat_member"): Event {
  const was = event.old_chat_member.status;
  const now = event.new_chat_member.status;
  const user = event.new_chat_member.user;
  const joined = !PRESENT.has(was) && PRESENT.has(now);

  let name = "membership_changed";
  if (joined) name = "joined";
  else if (PRESENT.has(was) && !PRESENT.has(now)) name = now === "kicked" ? "banned" : "left";
  else if (was !== now) name = "role_changed";

  const route = joined ? joinRoute(event) : undefined;

  return {
    messageType: name,
    chatId: event.chat.id,
    userId: user.id,
    chatType: event.chat.type,
    isBot: user.is_bot || undefined,
    detail: [`via=${kind}`, `${was}->${now}`, `by=${event.from.id}`, route && `route=${route}`]
      .filter(Boolean).join(","),
    membership: {
      userId: user.id,
      actorId: event.from.id,
      from: was,
      to: now,
      route,
      present: PRESENT.has(now),
      privileged: PRIVILEGED.has(now),
      via: kind,
    },
  };
}

/**
 * How the account got in. Order matters: an approved join request also carries
 * the link it was made against, and the approval is the fact that counts.
 */
function joinRoute(event: ChatMemberUpdated): JoinRoute {
  if (event.via_join_request) return "join_request";
  if (event.via_chat_folder_invite_link) return "chat_folder";
  if (event.invite_link) return "invite_link";
  // Somebody else moved them in: the member list, or an admin's doing.
  if (event.from.id !== event.new_chat_member.user.id) return "added_by_member";
  return "unaided";
}
