import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseConfig } from "../src/config.ts";

/** A minimally valid environment; each test overrides what it cares about. */
function env(overrides: Record<string, string> = {}) {
  const merged: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(64),
    ALLOWED_CHAT_IDS: "-1001234567890",
    ...overrides,
  };
  return (key: string) => merged[key];
}

Deno.test("the defaults are the cautious ones", () => {
  const { config, fatal, warnings } = parseConfig(env());
  assertEquals(fatal, []);
  assertEquals(warnings, []);
  assertEquals(config.dryRun, true);
  assertEquals(config.removeSelfJoins, true);
  assertEquals(config.allowInviteLinkJoins, true);
  assertEquals(config.removeUndisclosedJoins, false);
  assertEquals(config.joinRequestAction, "ignore");
  assertEquals(config.maxRemovalsPerHour, 20);
  assertEquals(config.logLevel, "info");
});

Deno.test("a missing bot token is fatal", () => {
  const { fatal } = parseConfig(env({ TELEGRAM_BOT_TOKEN: "" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "TELEGRAM_BOT_TOKEN");
});

Deno.test("an empty whitelist runs, but polices nothing", () => {
  const { fatal, warnings } = parseConfig(env({ ALLOWED_CHAT_IDS: "" }));
  assertEquals(fatal, []);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "ALLOWED_CHAT_IDS");
});

Deno.test("a malformed chat ID is refused rather than skipped", () => {
  const { fatal } = parseConfig(env({ ALLOWED_CHAT_IDS: "-100123,not-an-id" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "not-an-id");
});

Deno.test("an unparseable boolean is refused rather than taken as false", () => {
  const { fatal } = parseConfig(env({ DRY_RUN: "maybe" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "DRY_RUN");
});

Deno.test("a zero removal budget is refused: it would disable enforcement silently", () => {
  const { fatal } = parseConfig(env({ MAX_REMOVALS_PER_HOUR: "0" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "MAX_REMOVALS_PER_HOUR");
});

Deno.test("an unknown join-request action is refused", () => {
  const { fatal } = parseConfig(env({ JOIN_REQUEST_ACTION: "approve" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "JOIN_REQUEST_ACTION");
});

Deno.test("the two join settings contradicting each other is worth a warning", () => {
  const { fatal, warnings } = parseConfig(env({
    REMOVE_UNDISCLOSED_JOINS: "true",
    ALLOW_INVITE_LINK_JOINS: "true",
    REMOVE_SELF_JOINS: "false",
  }));
  assertEquals(fatal, []);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "does not disclose");
});

Deno.test("trusting invite links while self-joins are removed is worth a warning", () => {
  const { fatal, warnings } = parseConfig(env({ ALLOW_INVITE_LINK_JOINS: "true" }));
  assertEquals(fatal, []);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "REMOVE_SELF_JOINS");
});

Deno.test("a missing secret is fatal, not a warning", () => {
  const { fatal } = parseConfig(env({ TELEGRAM_WEBHOOK_SECRET: "" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "TELEGRAM_WEBHOOK_SECRET");
});

Deno.test("a short secret still runs, but is worth an operator's attention", () => {
  const { fatal, warnings } = parseConfig(env({ TELEGRAM_WEBHOOK_SECRET: "short" }));
  assertEquals(fatal, []);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "16 characters");
});

Deno.test("an unknown log level is refused rather than silently ignored", () => {
  const { fatal } = parseConfig(env({ LOG_LEVEL: "verbose" }));
  assertEquals(fatal.length, 1);
  assertStringIncludes(fatal[0], "LOG_LEVEL");
});

Deno.test("a known log level is taken", () => {
  const { config, fatal } = parseConfig(env({ LOG_LEVEL: "debug" }));
  assertEquals(fatal, []);
  assertEquals(config.logLevel, "debug");
  // Left as found, so the level does not leak into the other tests' output.
  parseConfig(env());
});
