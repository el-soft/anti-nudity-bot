// The subset of the Telegram Bot API shapes this bot reads. Deliberately partial:
// fields the bot never touches are omitted rather than typed loosely.

export interface User {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface Chat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface ChatFullInfo extends Chat {
  bio?: string;
  description?: string;
  photo?: { small_file_id: string; big_file_id: string; big_file_unique_id?: string };
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface Sticker {
  file_id: string;
  file_unique_id: string;
  is_animated?: boolean;
  is_video?: boolean;
  file_size?: number;
  thumbnail?: PhotoSize;
}

export interface Document {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: PhotoSize;
}

export interface VideoLike {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: PhotoSize;
}

export type ForwardOrigin =
  | { type: "user"; date: number; sender_user: User }
  | { type: "hidden_user"; date: number; sender_user_name: string }
  | { type: "chat"; date: number; sender_chat: Chat }
  | { type: "channel"; date: number; chat: Chat; message_id: number };

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  /** Present on a `text_mention`: the tapped account, id included. */
  user?: User;
}

export interface Message {
  message_id: number;
  date: number;
  text?: string;
  entities?: MessageEntity[];
  reply_to_message?: Message;
  from?: User;
  sender_chat?: Chat;
  chat: Chat;
  forward_origin?: ForwardOrigin;
  is_automatic_forward?: boolean;
  media_group_id?: string;
  photo?: PhotoSize[];
  sticker?: Sticker;
  document?: Document;
  video?: VideoLike;
  animation?: VideoLike;
  new_chat_members?: User[];
  left_chat_member?: User;
  new_chat_title?: string;
  new_chat_photo?: PhotoSize[];
  pinned_message?: Message;
  group_chat_created?: boolean;
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
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_invite_users?: boolean;
}

export interface ChatMemberUpdated {
  chat: Chat;
  from: User;
  date: number;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
  invite_link?: unknown;
  via_join_request?: boolean;
}

export interface ChatJoinRequest {
  chat: Chat;
  from: User;
  user_chat_id: number;
  date: number;
  invite_link?: unknown;
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  chat_member?: ChatMemberUpdated;
  my_chat_member?: ChatMemberUpdated;
  chat_join_request?: ChatJoinRequest;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface UserProfilePhotos {
  total_count: number;
  photos: PhotoSize[][];
}
