import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseConfig } from "../src/config.ts";

/** A minimally valid environment; each test overrides what it cares about. */
function env(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(64),
    ALLOWED_CHAT_IDS: "-1001234567890",
  };
  const merged = { ...base, ...overrides };
  return (key: string) => merged[key];
}

Deno.test("defaults match the documented ones", () => {
  const { config, fatal } = parseConfig(env());
  assertEquals(fatal, []);
  assertEquals(config.dryRun, true);
  assertEquals(config.nsfwThreshold, 0.7);
  assertEquals(config.profileNsfwThreshold, 0.9);
  assertEquals(config.nsfwClasses, ["Porn", "Hentai"]);
  assertEquals(config.banScope, "this_chat");
  assertEquals(config.maxBansPerHour, 10);
  assertEquals([...config.enforcementReasons], ["profile_nsfw", "harmful_link"]);
});

Deno.test("a ban threshold below the warn threshold is refused", () => {
  const { fatal } = parseConfig(env({ NSFW_THRESHOLD: "0.8", PROFILE_NSFW_THRESHOLD: "0.5" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "PROFILE_NSFW_THRESHOLD");
});

Deno.test("MAX_BANS_PER_HOUR=0 is refused as ambiguous", () => {
  const { fatal } = parseConfig(env({ MAX_BANS_PER_HOUR: "0" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "DRY_RUN");
});

Deno.test("a missing secret is fatal, not a warning", () => {
  const { fatal } = parseConfig(env({ TELEGRAM_WEBHOOK_SECRET: "" }));
  assert(fatal.some((f) => f.includes("TELEGRAM_WEBHOOK_SECRET")));
});

Deno.test("the whitelist fails closed on malformed input", () => {
  // "-0" is what an operator writes when they have not filled the value in yet.
  const { config, fatal } = parseConfig(env({ ALLOWED_CHAT_IDS: "-0" }));
  assertEquals(config.allowedChatIds.size, 0);
  assert(fatal.some((f) => f.includes("ALLOWED_CHAT_IDS")));
});

Deno.test("an empty whitelist warns rather than crashing", () => {
  const { config, fatal, warnings } = parseConfig(env({ ALLOWED_CHAT_IDS: "" }));
  assertEquals(config.allowedChatIds.size, 0);
  assertEquals(fatal, []);
  assert(warnings.some((w) => w.includes("ALLOWED_CHAT_IDS")));
});

Deno.test("a typo'd threshold surfaces as one clear error, not NaN", () => {
  const { fatal } = parseConfig(env({ NSFW_THRESHOLD: "0..7" }));
  assert(fatal.some((f) => f.includes("NSFW_THRESHOLD")));
});

Deno.test("unknown enum values are rejected", () => {
  const { fatal } = parseConfig(env({ MESSAGE_ACTION: "ban" }));
  assert(fatal.some((f) => f.includes("MESSAGE_ACTION")));
});

Deno.test("EXEMPT_JOINED_BEFORE parses to unix seconds", () => {
  const { config, fatal } = parseConfig(env({ EXEMPT_JOINED_BEFORE: "2026-09-04" }));
  assertEquals(fatal, []);
  assertEquals(config.exemptJoinedBefore, Math.floor(Date.parse("2026-09-04") / 1000));
});
