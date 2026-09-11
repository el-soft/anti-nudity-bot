// Every outbound call to the Bot API. The token appears only in the URLs built
// here and is never logged, never returned, and never put in an error message.
//
// Failures are values, not exceptions: a caller deciding whether to remove
// someone must be able to tell "checked and clean" from "could not check", and a
// thrown error makes those two look the same at the catch site.

import { errText, warn } from "../log.ts";
import type { ChatMember } from "./types.ts";

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; errorCode?: number; retryAfter?: number };

const API_ROOT = "https://api.telegram.org";

export class TelegramClient {
  #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /**
   * One attempt per call. A 429 is honoured once and then abandoned: a retry
   * loop inside a constrained invocation risks the deadline, and the decision is
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

  getMe() {
    return this.call<{ id: number; username?: string }>("getMe");
  }

  getChatMember(chatId: number, userId: number) {
    return this.call<ChatMember>("getChatMember", { chat_id: chatId, user_id: userId });
  }

  /** `revoke_messages` is deliberately never set: this bot deletes nothing. */
  banChatMember(chatId: number, userId: number) {
    return this.call<true>("banChatMember", {
      chat_id: chatId,
      user_id: userId,
      revoke_messages: false,
    });
  }

  /**
   * `only_if_banned` keeps this from turning into an invitation: without it,
   * unbanning someone who is merely absent is a no-op on some chats and a
   * membership change on others.
   */
  unbanChatMember(chatId: number, userId: number) {
    return this.call<true>("unbanChatMember", {
      chat_id: chatId,
      user_id: userId,
      only_if_banned: true,
    });
  }

  declineChatJoinRequest(chatId: number, userId: number) {
    return this.call<true>("declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  }
}
