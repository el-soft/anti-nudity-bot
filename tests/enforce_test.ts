import { assertEquals } from "@std/assert";
import { type Config, parseConfig } from "../src/config.ts";
import { type Context } from "../src/context.ts";
import { enforce, RemovalBudget } from "../src/enforce.ts";
import type { Decision } from "../src/policy.ts";
import type { ApiResult, TelegramClient } from "../src/telegram/api.ts";

const CHAT = -1001234567890;
const USER = 100;

function config(overrides: Record<string, string> = {}): Config {
  const merged: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(64),
    ALLOWED_CHAT_IDS: String(CHAT),
    DRY_RUN: "false",
    ...overrides,
  };
  const { config, fatal } = parseConfig((key) => merged[key]);
  assertEquals(fatal, []);
  return config;
}

/** Records the calls made, and can be told to fail any one of them. */
function stub(fails: Set<string> = new Set()) {
  const calls: string[] = [];
  const answer = (name: string): Promise<ApiResult<true>> => {
    calls.push(name);
    return Promise.resolve(
      fails.has(name)
        ? { ok: false as const, error: "not enough rights", errorCode: 400 }
        : { ok: true as const, value: true as const },
    );
  };
  const client = {
    banChatMember: () => answer("ban"),
    unbanChatMember: () => answer("unban"),
    declineChatJoinRequest: () => answer("decline"),
  } as unknown as TelegramClient;
  return { client, calls };
}

function context(cfg: Config, client: TelegramClient): Context {
  return {
    config: cfg,
    client,
    budget: new RemovalBudget(cfg.maxRemovalsPerHour),
    selfId: () => Promise.resolve(999),
  };
}

const remove: Decision = {
  action: "remove",
  reason: "joined_unaided",
  chatId: CHAT,
  userId: USER,
};

Deno.test("removing is a ban followed by an unban, in that order", async () => {
  const { client, calls } = stub();
  await enforce(context(config(), client), remove);
  // The unban is what keeps "removed" from meaning "blacklisted".
  assertEquals(calls, ["ban", "unban"]);
});

Deno.test("a failed ban does not go on to unban", async () => {
  const { client, calls } = stub(new Set(["ban"]));
  await enforce(context(config(), client), remove);
  assertEquals(calls, ["ban"]);
});

Deno.test("a failed unban leaves the account out, and is reported", async () => {
  const { client, calls } = stub(new Set(["unban"]));
  await enforce(context(config(), client), remove);
  assertEquals(calls, ["ban", "unban"]);
});

Deno.test("a dry run calls nothing", async () => {
  const { client, calls } = stub();
  await enforce(context(config({ DRY_RUN: "true" }), client), remove);
  assertEquals(calls, []);
});

Deno.test("a decision to do nothing calls nothing", async () => {
  const { client, calls } = stub();
  await enforce(context(config(), client), {
    action: "none",
    reason: "added_by_member",
    chatId: CHAT,
    userId: USER,
  });
  assertEquals(calls, []);
});

Deno.test("declining a join request is one call", async () => {
  const { client, calls } = stub();
  await enforce(context(config(), client), {
    action: "decline_join_request",
    reason: "join_request_declined_by_policy",
    chatId: CHAT,
    userId: USER,
  });
  assertEquals(calls, ["decline"]);
});

Deno.test("the hourly budget stops a runaway loop", async () => {
  const { client, calls } = stub();
  const ctx = context(config({ MAX_REMOVALS_PER_HOUR: "3" }), client);
  for (let i = 0; i < 6; i++) await enforce(ctx, remove);
  // Three removals, each a ban and an unban; the rest are refused outright.
  assertEquals(calls, ["ban", "unban", "ban", "unban", "ban", "unban"]);
});
