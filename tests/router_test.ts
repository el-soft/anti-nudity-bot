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
    self: () => Promise.resolve({ id: SELF, username: "testbot" }),
    selfId: () => Promise.resolve(SELF),
  };
}

const joinUpdate = (userId = JOINER, chat = CHAT): Update => ({
  update_id: 1,
  chat_member: {
    chat: { id: chat, type: "supergroup" },
    from: { id: 1 },
    date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: "left", user: { id: userId } },
    new_chat_member: { status: "member", user: { id: userId } },
  },
});

/** Each test needs a user ID nothing else has cached a verdict for. */
let nextUser = 900_000;
const freshUser = () => ++nextUser;

/** Each sweep test needs a chat with its own roster and its own ban budget. */
let nextChat = -1_002_000_000_000;
const freshChat = () => ++nextChat;

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

// --- /scan ------------------------------------------------------------------

const scanMessage = (
  text: string,
  fromId: number,
  extra: Record<string, unknown> = {},
  chat = CHAT,
): Update => ({
  update_id: 50,
  message: {
    message_id: 900,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chat, type: "supergroup" },
    from: { id: fromId, is_bot: false },
    text,
    ...extra,
  },
});

const adminStub = (extra: Record<string, unknown> = {}) =>
  stubClient({
    getChatMember: (_chatId: number, userId: number) =>
      Promise.resolve({
        ok: true as const,
        value: { status: userId === ADMIN ? "administrator" : "member", user: { id: userId } },
      }),
    ...extra,
  });

const ADMIN = 111111;

Deno.test("/scan from a non-admin is refused before anything is scanned", async () => {
  const client = adminStub();
  await dispatch(contextWith(client), scanMessage("/scan 555000", 222222));

  assertEquals(client.calls.filter((c) => c.method === "getChat").length, 0);
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
  const reply = client.calls.find((c) => c.method === "sendMessage");
  assert(reply, "the non-admin should be told why nothing happened");
  assert(String(reply.params.text).includes("admins"));
});

Deno.test("/scan by an admin on a flagged account removes it", async () => {
  const client = adminStub();
  const target = freshUser();
  await dispatch(contextWith(client), scanMessage(`/scan ${target}`, ADMIN));

  const ban = client.calls.find((c) => c.method === "banChatMember");
  assert(ban, "the flagged account should have been removed");
  assertEquals(ban.params.userId, target);
  assertEquals(ban.params.revoke, true);
});

Deno.test("/scan re-checks rather than replaying a cached verdict", async () => {
  const client = adminStub();
  const context = contextWith(client);
  const target = freshUser();

  // Prime the cache with a real scan.
  await dispatch(context, joinUpdate(target));
  const afterJoin = client.calls.filter((c) => c.method === "getChat").length;

  // An admin running /scan has usually just changed a threshold, so a cached
  // verdict would answer the question they no longer have.
  await dispatch(context, scanMessage(`/scan ${target}`, ADMIN));
  assert(
    client.calls.filter((c) => c.method === "getChat").length > afterJoin,
    "/scan should force a fresh profile fetch",
  );
});

Deno.test("/scan never removes an admin", async () => {
  const client = adminStub();
  await dispatch(contextWith(client), scanMessage(`/scan ${ADMIN}`, ADMIN));
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("/scan honours DRY_RUN", async () => {
  const client = adminStub();
  const target = freshUser();
  await dispatch(contextWith(client, { DRY_RUN: "true" }), scanMessage(`/scan ${target}`, ADMIN));

  assert(client.calls.some((c) => c.method === "getChat"), "the scan should still run");
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
  const reply = client.calls.find((c) => c.method === "sendMessage");
  assert(String(reply!.params.text).includes("DRY_RUN"));
});

Deno.test("a bare /scan sweeps the accounts the bot has actually seen", async () => {
  // Its own chat: the roster and the ban budget are per-chat, and the in-process
  // fallback store is shared across tests.
  const chat = freshChat();
  const client = adminStub();
  const context = contextWith(client, { ALLOWED_CHAT_IDS: String(chat), MAX_BANS_PER_HOUR: "50" });
  const seen = [freshUser(), freshUser()];

  // The roster is built from sightings; nothing else can build it, because the
  // Bot API has no way to list a group's members.
  for (const user of seen) await dispatch(context, joinUpdate(user, chat));

  const before = client.calls.filter((c) => c.method === "banChatMember").length;
  await dispatch(context, scanMessage("/scan", ADMIN, {}, chat));
  const banned = client.calls
    .filter((c) => c.method === "banChatMember")
    .slice(before)
    .map((c) => c.params.userId);

  for (const user of seen) assert(banned.includes(user), `${user} should have been swept`);

  const reply = client.calls.filter((c) => c.method === "sendMessage").pop();
  // The reply must not let an admin believe they swept the whole group.
  assert(String(reply!.params.text).includes("list a group's members"));
});

Deno.test("/scan reports honestly when the bot has seen nobody", async () => {
  const chat = freshChat();
  const client = adminStub();
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat) }),
    scanMessage("/scan", ADMIN, {}, chat),
  );
  const reply = client.calls.find((c) => c.method === "sendMessage");
  assert(String(reply!.params.text).includes("haven't seen anyone"));
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("/scan is inert outside the whitelist", async () => {
  const client = adminStub();
  const update = scanMessage("/scan", ADMIN);
  update.message!.chat.id = -1009999999999;
  await dispatch(contextWith(client), update);
  assertEquals(client.calls.length, 0);
});

Deno.test("SCAN_COMMAND=false disables the command", async () => {
  const client = adminStub();
  await dispatch(
    contextWith(client, { SCAN_COMMAND: "false" }),
    scanMessage(`/scan ${freshUser()}`, ADMIN),
  );
  assertEquals(client.calls.filter((c) => c.method === "banChatMember").length, 0);
});

Deno.test("a join request puts the account on the roster", async () => {
  const chat = freshChat();
  const client = adminStub({
    // Clean bio, so the request is neither declined nor banned — the point is
    // purely that the account is now known to the bot.
    getChat: (chatId: number) =>
      Promise.resolve({ ok: true as const, value: { id: chatId, type: "private", bio: "hi" } }),
  });
  const context = contextWith(client, { ALLOWED_CHAT_IDS: String(chat) });
  const user = freshUser();

  await dispatch(context, {
    update_id: 60,
    chat_join_request: {
      chat: { id: chat, type: "supergroup" },
      from: { id: user },
      user_chat_id: user,
      date: Math.floor(Date.now() / 1000),
    },
  });

  await dispatch(context, scanMessage("/scan", ADMIN, {}, chat));
  const reply = client.calls.filter((c) => c.method === "sendMessage").pop();
  assert(
    String(reply!.params.text).includes("1 known account") ||
      String(reply!.params.text).includes("of 1"),
    `the applicant should be on the roster: ${reply!.params.text}`,
  );
});

Deno.test("a sweep never bans an account that has left the group", async () => {
  const chat = freshChat();
  const gone = freshUser();
  const client = adminStub({
    getChatMember: (_chatId: number, userId: number) =>
      Promise.resolve({
        ok: true as const,
        value: {
          status: userId === ADMIN ? "administrator" : userId === gone ? "left" : "member",
          user: { id: userId },
        },
      }),
  });
  const context = contextWith(client, { ALLOWED_CHAT_IDS: String(chat), MAX_BANS_PER_HOUR: "50" });

  await dispatch(context, joinUpdate(gone, chat));
  const before = client.calls.filter((c) => c.method === "banChatMember").length;

  await dispatch(context, scanMessage("/scan", ADMIN, {}, chat));

  // banChatMember works on non-members, so without the membership check this
  // would pre-emptively ban someone who already left.
  assertEquals(
    client.calls.filter((c) => c.method === "banChatMember").length,
    before,
    "an account that has left must not be banned by a sweep",
  );
  const reply = client.calls.filter((c) => c.method === "sendMessage").pop();
  assert(String(reply!.params.text).includes("no longer in the group"));
});

Deno.test("an account that has left is pruned from the roster", async () => {
  const chat = freshChat();
  const gone = freshUser();
  const client = adminStub({
    getChatMember: (_chatId: number, userId: number) =>
      Promise.resolve({
        ok: true as const,
        value: {
          status: userId === ADMIN ? "administrator" : userId === gone ? "left" : "member",
          user: { id: userId },
        },
      }),
  });
  const context = contextWith(client, { ALLOWED_CHAT_IDS: String(chat) });

  await dispatch(context, joinUpdate(gone, chat));
  await dispatch(context, scanMessage("/scan", ADMIN, {}, chat));
  await dispatch(context, scanMessage("/scan", ADMIN, {}, chat));

  const reply = client.calls.filter((c) => c.method === "sendMessage").pop();
  // Second sweep: the roster is empty again, so the bot says so rather than
  // re-reporting the same departed account forever.
  assert(String(reply!.params.text).includes("haven't seen anyone"));
});

Deno.test("a poster is added to the roster and swept later", async () => {
  const chat = freshChat();
  const client = adminStub({
    getChat: (chatId: number) =>
      Promise.resolve({ ok: true as const, value: { id: chatId, type: "private", bio: "hello" } }),
  });
  const context = contextWith(client, { ALLOWED_CHAT_IDS: String(chat) });
  const poster = freshUser();

  await dispatch(context, {
    update_id: 70,
    message: {
      message_id: 800,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: "supergroup" },
      from: { id: poster, is_bot: false },
      text: "hello everyone",
    },
  });

  await dispatch(context, scanMessage("/scan", ADMIN, {}, chat));
  const reply = client.calls.filter((c) => c.method === "sendMessage").pop();
  assert(String(reply!.params.text).includes("of 1"), String(reply!.params.text));
});

Deno.test("the result goes to the admin privately, not to the group", async () => {
  const chat = freshChat();
  const client = adminStub();
  const target = freshUser();
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat) }),
    scanMessage(`/scan ${target}`, ADMIN, {}, chat),
  );

  const sends = client.calls.filter((c) => c.method === "sendMessage");
  assertEquals(sends.length, 1);
  // Scores and account IDs belong in front of the admin who asked, not in front
  // of everyone they moderate.
  assertEquals(sends[0].params.chatId, ADMIN);
});

Deno.test("the /scan message is deleted from the group", async () => {
  const chat = freshChat();
  const client = adminStub();
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat) }),
    scanMessage(`/scan ${freshUser()}`, ADMIN, {}, chat),
  );

  const deleted = client.calls.find(
    (c) => c.method === "deleteMessage" && c.params.messageId === 900,
  );
  assert(deleted, "the command message should have been removed");
  assertEquals(deleted.params.chatId, chat);
});

Deno.test("a non-admin's /scan is removed too, and refused privately", async () => {
  const chat = freshChat();
  const client = adminStub();
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat) }),
    scanMessage("/scan", 222222, {}, chat),
  );

  assert(client.calls.some((c) => c.method === "deleteMessage" && c.params.messageId === 900));
  const send = client.calls.find((c) => c.method === "sendMessage");
  assertEquals(send!.params.chatId, 222222);
  assert(String(send!.params.text).includes("admins"));
});

Deno.test("when the admin has never opened a chat with the bot, it answers in the group", async () => {
  const chat = freshChat();
  const client = adminStub({
    sendMessage: (chatId: number, text: string) => {
      // Telegram refuses a DM to a user who has not started the bot.
      if (chatId === ADMIN) {
        return Promise.resolve({
          ok: false as const,
          error: "Forbidden: bot can't initiate conversation with a user",
        });
      }
      client.calls.push({ method: "sendMessage", params: { chatId, text } });
      return Promise.resolve({ ok: true as const, value: { message_id: 1 } });
    },
  });
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat) }),
    scanMessage(`/scan ${freshUser()}`, ADMIN, {}, chat),
  );

  const send = client.calls.find((c) => c.method === "sendMessage");
  assert(send, "silence would leave the admin with no idea what the command did");
  assertEquals(send.params.chatId, chat);
  assert(String(send.params.text).includes("press Start"));
});

Deno.test("SCAN_COMMAND=false leaves the message alone", async () => {
  const chat = freshChat();
  const client = adminStub();
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat), SCAN_COMMAND: "false" }),
    scanMessage("/scan", ADMIN, {}, chat),
  );
  // The feature is off, so the bot does not tidy the group on its behalf either.
  assertEquals(client.calls.filter((c) => c.method === "deleteMessage").length, 0);
});

Deno.test("a failed delete does not stop the scan", async () => {
  const chat = freshChat();
  const client = adminStub({
    deleteMessage: () =>
      Promise.resolve({ ok: false as const, error: "Bad Request: message can't be deleted" }),
  });
  const target = freshUser();
  await dispatch(
    contextWith(client, { ALLOWED_CHAT_IDS: String(chat) }),
    scanMessage(`/scan ${target}`, ADMIN, {}, chat),
  );

  assert(
    client.calls.some((c) => c.method === "banChatMember" && c.params.userId === target),
    "a missing can_delete_messages right must not disable scanning",
  );
});
