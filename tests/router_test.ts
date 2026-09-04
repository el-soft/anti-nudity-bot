// End-to-end through the router with a stubbed Bot API. The bio path is used
// deliberately: it reaches a real enforcement decision without loading the model.

import { assert, assertEquals } from "@std/assert";
import { parseConfig } from "../src/config.ts";
import type { Context } from "../src/context.ts";
import { Blocklist } from "../src/links/blocklist.ts";
import { dispatch } from "../src/router.ts";
import type { ApiResult, TelegramClient } from "../src/telegram/api.ts";
import type { Update } from "../src/telegram/types.ts";

const CHAT = -1001234567890;
const JOINER = 777888999;
const SELF = 42;

interface Recorded {
  method: string;
  params: Record<string, unknown>;
}

/** A stub with just the methods the handlers reach for. */
function stubClient(overrides: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const record = <T>(method: string, params: Record<string, unknown>, value: T): ApiResult<T> => {
    calls.push({ method, params });
    return { ok: true, value };
  };

  const client = {
    calls,
    getMe: () => Promise.resolve(record("getMe", {}, { id: SELF })),
    getChatMember: (chatId: number, userId: number) =>
      Promise.resolve(
        record("getChatMember", { chatId, userId }, { status: "member", user: { id: userId } }),
      ),
    getChat: (chatId: number) =>
      Promise.resolve(
        record("getChat", { chatId }, { id: chatId, type: "private", bio: "dm me: bad[.]example" }),
      ),
    getUserProfilePhotos: (userId: number) =>
      Promise.resolve(record("getUserProfilePhotos", { userId }, { total_count: 0, photos: [] })),
    banChatMember: (chatId: number, userId: number, revoke: boolean) =>
      Promise.resolve(record("banChatMember", { chatId, userId, revoke }, true as const)),
    deleteMessage: (chatId: number, messageId: number) =>
      Promise.resolve(record("deleteMessage", { chatId, messageId }, true as const)),
    declineChatJoinRequest: (chatId: number, userId: number) =>
      Promise.resolve(record("declineChatJoinRequest", { chatId, userId }, true as const)),
    sendMessage: (chatId: number, text: string) =>
      Promise.resolve(record("sendMessage", { chatId, text }, { message_id: 1 })),
    leaveChat: (chatId: number) => Promise.resolve(record("leaveChat", { chatId }, true as const)),
    download: () => Promise.resolve({ ok: false as const, error: "not used in this test" }),
    ...overrides,
  };
  return client;
}

function contextWith(
  client: ReturnType<typeof stubClient>,
  overrides: Record<string, string> = {},
): Context {
  const { config } = parseConfig((key) =>
    ({
      TELEGRAM_BOT_TOKEN: "1:a",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
      ALLOWED_CHAT_IDS: String(CHAT),
      LINK_BLOCKLIST: "bad.example",
      DRY_RUN: "false",
      ...overrides,
    } as Record<string, string>)[key]
  );
  return {
    config,
    client: client as unknown as TelegramClient,
    blocklist: new Blocklist(config.linkBlocklist, null),
    selfId: () => Promise.resolve(SELF),
  };
}

const joinUpdate = (userId = JOINER): Update => ({
  update_id: 1,
  chat_member: {
    chat: { id: CHAT, type: "supergroup" },
    from: { id: 1 },
    date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: "left", user: { id: userId } },
    new_chat_member: { status: "member", user: { id: userId } },
  },
});

/** Each test needs a user ID nothing else has cached a verdict for. */
let nextUser = 900_000;
const freshUser = () => ++nextUser;

Deno.test("a joiner with a blocklisted bio is banned with their history revoked", async () => {
  const client = stubClient();
  const user = freshUser();
  await dispatch(contextWith(client), joinUpdate(user));

  const ban = client.calls.find((c) => c.method === "banChatMember");
  assert(ban, "the account should have been banned");
  assertEquals(ban.params.chatId, CHAT);
  assertEquals(ban.params.userId, user);
  // revoke_messages is the only Bot API route to clearing an account's history.
  assertEquals(ban.params.revoke, true);
});

Deno.test("DRY_RUN runs the scan end to end and bans nobody", async () => {
  const client = stubClient();
  await dispatch(contextWith(client, { DRY_RUN: "true" }), joinUpdate(freshUser()));

  assert(client.calls.some((c) => c.method === "getChat"), "the scan should still run");
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("an update from a chat outside the whitelist costs nothing", async () => {
  const client = stubClient();
  const update = joinUpdate(freshUser());
  update.chat_member!.chat.id = -1009999999999;
  await dispatch(contextWith(client), update);
  assertEquals(client.calls.length, 0, "nothing should be fetched for an unlisted chat");
});

Deno.test("a chat admin is never scanned, let alone banned", async () => {
  const client = stubClient({
    getChatMember: (_chatId: number, userId: number) =>
      Promise.resolve({
        ok: true as const,
        value: { status: "administrator", user: { id: userId } },
      }),
  });
  await dispatch(contextWith(client), joinUpdate(freshUser()));
  assertEquals(client.calls.filter((c) => c.method === "getChat").length, 0);
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("harmful_link outside ENFORCEMENT_REASONS is logged, not acted on", async () => {
  const client = stubClient();
  await dispatch(
    contextWith(client, { ENFORCEMENT_REASONS: "profile_nsfw" }),
    joinUpdate(freshUser()),
  );
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("a join request is declined, never banned", async () => {
  const user = freshUser();
  const client = stubClient();
  const update: Update = {
    update_id: 2,
    chat_join_request: {
      chat: { id: CHAT, type: "supergroup" },
      from: { id: user },
      user_chat_id: user,
      date: Math.floor(Date.now() / 1000),
    },
  };
  await dispatch(contextWith(client), update);

  assert(client.calls.some((c) => c.method === "declineChatJoinRequest"));
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("a clean join request is left for a human by default", async () => {
  const client = stubClient({
    getChat: (chatId: number) =>
      Promise.resolve({ ok: true as const, value: { id: chatId, type: "private", bio: "hello" } }),
  });
  const user = freshUser();
  const update: Update = {
    update_id: 3,
    chat_join_request: {
      chat: { id: CHAT, type: "supergroup" },
      from: { id: user },
      user_chat_id: user,
      date: Math.floor(Date.now() / 1000),
    },
  };
  await dispatch(contextWith(client), update);

  assertEquals(client.calls.filter((c) => c.method === "declineChatJoinRequest").length, 0);
  assertEquals(client.calls.filter((c) => c.method === "approveChatJoinRequest").length, 0);
});

Deno.test("the bot leaves a chat it was added to that is not whitelisted", async () => {
  const client = stubClient();
  const update: Update = {
    update_id: 4,
    my_chat_member: {
      chat: { id: -1005555555555, type: "supergroup" },
      from: { id: 1 },
      date: 1,
      old_chat_member: { status: "left", user: { id: SELF } },
      new_chat_member: { status: "member", user: { id: SELF } },
    },
  };
  await dispatch(contextWith(client), update);
  assert(client.calls.some((c) => c.method === "leaveChat"));
});

Deno.test("a second signal about the same account hits the cache", async () => {
  const client = stubClient();
  const context = contextWith(client);
  const user = freshUser();

  await dispatch(context, joinUpdate(user));
  const afterFirst = client.calls.filter((c) => c.method === "getChat").length;

  // chat_member and new_chat_members can both fire for one join.
  await dispatch(context, joinUpdate(user));
  assertEquals(
    client.calls.filter((c) => c.method === "getChat").length,
    afterFirst,
    "the duplicate should resolve to a cache lookup, not a rescan",
  );
});
