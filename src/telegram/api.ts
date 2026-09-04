// Every outbound call to the Bot API. The token appears only in the URLs built
// here and is never logged, never returned, and never put in an error message.
//
// Failures are values, not exceptions: a caller deciding whether to ban someone
// must be able to tell "checked and clean" from "could not check", and a thrown
// error makes those two look the same at the catch site.

import { errText, warn } from "../log.ts";
import type {
  ChatFullInfo,
  ChatMember,
  Message,
  TelegramFile,
  UserProfilePhotos,
} from "./types.ts";

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; errorCode?: number; retryAfter?: number };

const API_ROOT = "https://api.telegram.org";

export class TelegramClient {
  #token: string;
  #maxFileBytes: number;

  constructor(token: string, maxFileBytes: number) {
    this.#token = token;
    this.#maxFileBytes = maxFileBytes;
  }

  /**
   * One attempt per call. A 429 is honoured once and then abandoned: a retry
   * loop inside a constrained invocation risks the deadline, and the verdict is
   * already in the audit log either way.
   */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<ApiResult<T>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${API_ROOT}/bot${this.#token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
      } catch (e) {
        return { ok: false, error: `network: ${errText(e)}` };
      }

      let body: {
        ok?: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      try {
        body = await response.json();
      } catch (e) {
        return { ok: false, error: `bad response: ${errText(e)}`, errorCode: response.status };
      }

      if (body.ok && body.result !== undefined) return { ok: true, value: body.result };

      const retryAfter = body.parameters?.retry_after;
      if (response.status === 429 && retryAfter !== undefined && attempt === 0 && retryAfter <= 5) {
        warn({ event: "rate_limited", method, retry_after: retryAfter });
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      return {
        ok: false,
        error: body.description ?? `http ${response.status}`,
        errorCode: body.error_code ?? response.status,
        retryAfter,
      };
    }
    return { ok: false, error: "retry budget exhausted" };
  }

  getChat(chatId: number) {
    return this.call<ChatFullInfo>("getChat", { chat_id: chatId });
  }

  getChatMember(chatId: number, userId: number) {
    return this.call<ChatMember>("getChatMember", { chat_id: chatId, user_id: userId });
  }

  getUserProfilePhotos(userId: number, limit: number) {
    return this.call<UserProfilePhotos>("getUserProfilePhotos", { user_id: userId, limit });
  }

  getMe() {
    return this.call<{ id: number; username?: string }>("getMe");
  }

  sendMessage(chatId: number, text: string, replyToMessageId?: number) {
    return this.call<Message>("sendMessage", {
      chat_id: chatId,
      text,
      // A warning under a deleted or missing message should still be delivered,
      // rather than failing the whole send.
      reply_parameters: replyToMessageId
        ? { message_id: replyToMessageId, allow_sending_without_reply: true }
        : undefined,
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<true>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  banChatMember(chatId: number, userId: number, revokeMessages: boolean) {
    return this.call<true>("banChatMember", {
      chat_id: chatId,
      user_id: userId,
      revoke_messages: revokeMessages,
    });
  }

  approveChatJoinRequest(chatId: number, userId: number) {
    return this.call<true>("approveChatJoinRequest", { chat_id: chatId, user_id: userId });
  }

  declineChatJoinRequest(chatId: number, userId: number) {
    return this.call<true>("declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  }

  leaveChat(chatId: number) {
    return this.call<true>("leaveChat", { chat_id: chatId });
  }

  /**
   * Resolve a file_id and download the bytes. Size is checked twice — against
   * `getFile`'s reported size, and against the streamed length — because
   * `file_size` is absent often enough that trusting it alone is how an
   * oversized download gets through.
   */
  async download(fileId: string): Promise<ApiResult<{ bytes: Uint8Array; path: string }>> {
    const file = await this.call<TelegramFile>("getFile", { file_id: fileId });
    if (!file.ok) return file;
    if (!file.value.file_path) return { ok: false, error: "getFile returned no file_path" };
    if (file.value.file_size !== undefined && file.value.file_size > this.#maxFileBytes) {
      return { ok: false, error: `too_large: ${file.value.file_size}` };
    }

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/file/bot${this.#token}/${file.value.file_path}`);
    } catch (e) {
      return { ok: false, error: `network: ${errText(e)}` };
    }
    if (!response.ok) {
      return { ok: false, error: `download http ${response.status}`, errorCode: response.status };
    }

    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > this.#maxFileBytes) {
      return { ok: false, error: `too_large: ${declared}` };
    }

    const bytes = await this.#readCapped(response);
    if (!bytes) return { ok: false, error: `too_large: > ${this.#maxFileBytes}` };
    return { ok: true, value: { bytes, path: file.value.file_path } };
  }

  /** Reads a body, aborting the moment it exceeds the cap. */
  async #readCapped(response: Response): Promise<Uint8Array | null> {
    if (!response.body) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > this.#maxFileBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
