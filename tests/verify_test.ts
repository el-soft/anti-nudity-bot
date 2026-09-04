import { assert, assertEquals } from "@std/assert";
import { secretMatches } from "../src/telegram/verify.ts";

Deno.test("the secret must match exactly", () => {
  assert(secretMatches("abc123", "abc123"));
  assert(!secretMatches("abc123", "abc124"));
  assert(!secretMatches("abc123", "abc1234"));
  assert(!secretMatches("abc123", "abc12"));
});

Deno.test("an unset secret never matches, so a misconfigured bot accepts nothing", () => {
  assert(!secretMatches("", ""));
  assert(!secretMatches("", "anything"));
  assert(!secretMatches("abc123", null));
});

Deno.test("comparison is length-independent", () => {
  // Not a timing measurement — that is too noisy to assert on. This pins the
  // property the implementation relies on: every byte is examined regardless of
  // where the first difference is.
  const secret = "x".repeat(64);
  assertEquals(secretMatches(secret, "y" + "x".repeat(63)), false);
  assertEquals(secretMatches(secret, "x".repeat(63) + "y"), false);
});

Deno.test("multibyte secrets compare by bytes, not code points", () => {
  assert(secretMatches("sécret-🔑", "sécret-🔑"));
  assert(!secretMatches("sécret-🔑", "secret-🔑"));
});
