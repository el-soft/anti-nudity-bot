// The subset of the Telegram Bot API shapes this bot reads. Deliberately partial:
// only what is needed to name an update and pull the chat and user out of it.
// Payload-shaped fields the bot never looks inside are typed `unknown`.

export interface User {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface Chat {
  id: number;
  type?: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface Message {
  message_id: number;
  date: number;
  from?: User;
  sender_chat?: Chat;
  chat: Chat;

  forward_origin?: { type: string };
  is_automatic_forward?: boolean;
  reply_to_message?: Message;

  // Content. Presence of one of these names the message type.
  text?: string;
  photo?: unknown[];
  sticker?: unknown;
  document?: unknown;
  video?: unknown;
  animation?: unknown;
  audio?: unknown;
  voice?: unknown;
  video_note?: unknown;
  paid_media?: unknown;
  story?: unknown;
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  dice?: unknown;
  game?: unknown;
  invoice?: unknown;

  // Service messages.
  new_chat_members?: User[];
  left_chat_member?: User;
  new_chat_title?: string;
  new_chat_photo?: unknown[];
  delete_chat_photo?: boolean;
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  channel_chat_created?: boolean;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  pinned_message?: Message;
  successful_payment?: unknown;
  refunded_payment?: unknown;
  users_shared?: unknown;
  chat_shared?: unknown;
  write_access_allowed?: unknown;
  message_auto_delete_timer_changed?: unknown;
  boost_added?: unknown;
  forum_topic_created?: unknown;
  forum_topic_edited?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
  video_chat_scheduled?: unknown;
  video_chat_started?: unknown;
  video_chat_ended?: unknown;
  video_chat_participants_invited?: unknown;
  web_app_data?: unknown;
}

export type ChatMemberStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked";

export interface ChatMember {
  status: ChatMemberStatus;
  user: User;
  is_member?: boolean;
}

export interface ChatMemberUpdated {
  chat: Chat;
  from: User;
  date: number;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
  via_join_request?: boolean;
}

export interface ChatJoinRequest {
  chat: Chat;
  from: User;
  user_chat_id: number;
  date: number;
}

export interface MessageReactionUpdated {
  chat: Chat;
  message_id: number;
  user?: User;
  actor_chat?: Chat;
  date: number;
}

export interface MessageReactionCountUpdated {
  chat: Chat;
  message_id: number;
  date: number;
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: { chat?: Chat; message_id?: number };
}

export interface InlineQuery {
  id: string;
  from: User;
}

export interface ChosenInlineResult {
  result_id: string;
  from: User;
}

export interface PollAnswer {
  poll_id: string;
  user?: User;
  voter_chat?: Chat;
}

export interface ChatBoostUpdated {
  chat: Chat;
  boost?: { source?: { user?: User } };
}

export interface ChatBoostRemoved {
  chat: Chat;
  source?: { user?: User };
}

export interface BusinessConnection {
  id: string;
  user: User;
  user_chat_id: number;
}

export interface DeletedBusinessMessages {
  business_connection_id: string;
  chat: Chat;
  message_ids: number[];
}

export interface PaidMediaPurchased {
  from: User;
}

export interface PreCheckoutQuery {
  id: string;
  from: User;
}

export interface ShippingQuery {
  id: string;
  from: User;
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  edited_channel_post?: Message;
  business_connection?: BusinessConnection;
  business_message?: Message;
  edited_business_message?: Message;
  deleted_business_messages?: DeletedBusinessMessages;
  message_reaction?: MessageReactionUpdated;
  message_reaction_count?: MessageReactionCountUpdated;
  inline_query?: InlineQuery;
  chosen_inline_result?: ChosenInlineResult;
  callback_query?: CallbackQuery;
  shipping_query?: ShippingQuery;
  pre_checkout_query?: PreCheckoutQuery;
  purchased_paid_media?: PaidMediaPurchased;
  poll?: { id: string };
  poll_answer?: PollAnswer;
  my_chat_member?: ChatMemberUpdated;
  chat_member?: ChatMemberUpdated;
  chat_join_request?: ChatJoinRequest;
  chat_boost?: ChatBoostUpdated;
  removed_chat_boost?: ChatBoostRemoved;
}
