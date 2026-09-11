// update -> one flat record: what kind of update it is, which chat it came from,
// and which account is behind it. Pure and unit-tested; this is the whole bot.

import type { ChatMemberUpdated, Message, Update } from "./telegram/types.ts";

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
    return message.new_chat_members.map((user) => ({
      ...base,
      messageType: "joined",
      userId: user.id,
      isBot: user.is_bot || undefined,
      detail: "via=service_message",
    }));
  }

  if (message.left_chat_member) {
    return [{
      ...base,
      messageType: "left",
      userId: message.left_chat_member.id,
      isBot: message.left_chat_member.is_bot || undefined,
      detail: "via=service_message",
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
function membership(event: ChatMemberUpdated, kind: string): Event {
  const was = event.old_chat_member.status;
  const now = event.new_chat_member.status;

  let name = "membership_changed";
  if (!PRESENT.has(was) && PRESENT.has(now)) name = "joined";
  else if (PRESENT.has(was) && !PRESENT.has(now)) name = now === "kicked" ? "banned" : "left";
  else if (was !== now) name = "role_changed";

  return {
    messageType: name,
    chatId: event.chat.id,
    userId: event.new_chat_member.user.id,
    chatType: event.chat.type,
    isBot: event.new_chat_member.user.is_bot || undefined,
    detail: `via=${kind},${was}->${now},by=${event.from.id}`,
  };
}
