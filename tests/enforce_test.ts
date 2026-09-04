import { assert, assertEquals } from "@std/assert";
import { parseConfig } from "../src/config.ts";
import { reserve } from "../src/enforce/budget.ts";
import { staticExemption } from "../src/enforce/exempt.ts";
import { shouldEnforce } from "../src/enforce/actions.ts";
import type { Subject } from "../src/telegram/subjects.ts";

const configWith = (overrides: Record<string, string> = {}) =>
  parseConfig((key) =>
    ({
      TELEGRAM_BOT_TOKEN: "1:a",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
      ALLOWED_CHAT_IDS: "-100",
      ...overrides,
    } as Record<string, string>)[key]
  ).config;

const subject = (fields: Partial<Subject> = {}): Subject => ({
  userId: 500,
  isBot: false,
  actionable: true,
  role: "sender",
  ...fields,
});

Deno.test("the bot never scans itself", () => {
  const result = staticExemption(subject({ userId: 42 }), configWith(), 42);
  assert(result.exempt && result.reason === "self");
});

Deno.test("other bots are exempt unless SCAN_BOTS is set", () => {
  const bot = subject({ isBot: true });
  assert(staticExemption(bot, configWith(), 42).exempt);
  assertEquals(staticExemption(bot, configWith({ SCAN_BOTS: "true" }), 42).exempt, false);
});

Deno.test("EXEMPT_USER_IDS is honoured", () => {
  const config = configWith({ EXEMPT_USER_IDS: "500,600" });
  assert(staticExemption(subject(), config, 42).exempt);
  assertEquals(staticExemption(subject({ userId: 700 }), config, 42).exempt, false);
});

Deno.test("SCAN_PROFILE=false disables Track B entirely", () => {
  const result = staticExemption(subject(), configWith({ SCAN_PROFILE: "false" }), 42);
  assert(result.exempt && result.reason === "profile_scan_disabled");
});

Deno.test("ENFORCEMENT_REASONS selects which findings escalate", () => {
  const defaults = configWith();
  assert(shouldEnforce("profile_nsfw", defaults));
  assert(shouldEnforce("harmful_link", defaults));
  // A single bad photo can be a mistake or a forward; not a ban by default.
  assertEquals(shouldEnforce("message_nsfw", defaults), false);

  const linksOnly = configWith({ ENFORCEMENT_REASONS: "harmful_link" });
  assertEquals(shouldEnforce("profile_nsfw", linksOnly), false);
  assert(shouldEnforce("harmful_link", linksOnly));
});

Deno.test("the circuit breaker stops enforcement at the cap and resets each hour", async () => {
  const config = configWith({ MAX_BANS_PER_HOUR: "3" });
  const chat = -100_000 - Math.floor(Math.random() * 100_000); // isolate from other tests
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);

  for (let i = 0; i < 3; i++) {
    const decision = await reserve(chat, config, now);
    assert(decision.allowed, `ban ${i + 1} should be within budget`);
    assertEquals(decision.remaining, 2 - i);
  }

  const blocked = await reserve(chat, config, now);
  assertEquals(blocked.allowed, false);
  assertEquals(blocked.remaining, 0);

  // The next hour starts a fresh window.
  const nextHour = await reserve(chat, config, now + 3_600_000);
  assert(nextHour.allowed);
  assertEquals(nextHour.remaining, 2);
});

Deno.test("budgets are per chat", async () => {
  const config = configWith({ MAX_BANS_PER_HOUR: "1" });
  const now = Date.UTC(2026, 8, 4, 13, 0, 0);
  const a = -200_001, b = -200_002;
  assert((await reserve(a, config, now)).allowed);
  assertEquals((await reserve(a, config, now)).allowed, false);
  assert((await reserve(b, config, now)).allowed, "a different chat has its own budget");
});
