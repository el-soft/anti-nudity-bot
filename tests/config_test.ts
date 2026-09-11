import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseConfig } from "../src/config.ts";

/** A minimally valid environment; each test overrides what it cares about. */
function env(overrides: Record<string, string> = {}) {
  const merged: Record<string, string> = {
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(64),
    ...overrides,
  };
  return (key: string) => merged[key];
}

Deno.test("a valid environment parses with no complaints", () => {
  const { config, fatal, warnings } = parseConfig(env());
  assertEquals(fatal, []);
  assertEquals(warnings, []);
  assertEquals(config.logLevel, "info");
  assertEquals(config.webhookSecret, "a".repeat(64));
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
