import { assert, assertEquals } from "@std/assert";
import { parseConfig } from "../src/config.ts";
import { Blocklist, checkBioLinks } from "../src/links/blocklist.ts";
import { domainChain, extractLinks, normalizeText } from "../src/links/normalize.ts";

const configWith = (overrides: Record<string, string> = {}) =>
  parseConfig((key) =>
    ({
      TELEGRAM_BOT_TOKEN: "1:a",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
      ALLOWED_CHAT_IDS: "-100",
      ...overrides,
    } as Record<string, string>)[key]
  ).config;

Deno.test("dot substitutes and zero-width characters are folded", () => {
  assertEquals(normalizeText("evil[.]example[.]com"), "evil.example.com");
  assertEquals(normalizeText("evil(dot)example(dot)com"), "evil.example.com");
  assertEquals(normalizeText("evil​example​.com"), "evilexample.com");
  assertEquals(normalizeText("evil․example.com"), "evil.example.com");
  // NFKC folds fullwidth lookalikes onto ASCII before anything tries to match.
  assertEquals(normalizeText("ｅｘａｍｐｌｅ．ｃｏｍ"), "example.com");
});

Deno.test("links are found in URLs, bare hosts and @handles", () => {
  const links = extractLinks("see https://spam.example.com/x or spam.example.com and @some_handle");
  const hosts = links.map((l) => l.host);
  assert(hosts.includes("spam.example.com"));
  assert(hosts.includes("t.me"));
  assert(links.some((l) => l.handle));
});

Deno.test("t.me invite links are recognised", () => {
  assert(extractLinks("t.me/+AbCdEfGh").some((l) => l.invite));
  assert(extractLinks("https://t.me/joinchat/XYZ").some((l) => l.invite));
  assert(!extractLinks("t.me/publicchannel").some((l) => l.invite));
});

Deno.test("the domain chain is what makes one entry cover subdomains", () => {
  assertEquals(domainChain("a.b.example.co.uk"), [
    "a.b.example.co.uk",
    "b.example.co.uk",
    "example.co.uk",
    "co.uk",
  ]);
});

Deno.test("a parent-domain entry matches its subdomains", () => {
  const blocklist = new Blocklist(["example.com"], null);
  assertEquals(blocklist.match("deep.sub.example.com"), "example.com");
  assertEquals(blocklist.match("example.com"), "example.com");
  assertEquals(blocklist.match("notexample.com"), null);
  // A suffix match must not be a substring match.
  assertEquals(blocklist.match("myexample.com"), null);
});

Deno.test("an obfuscated blocklisted domain in a bio is still caught", () => {
  const blocklist = new Blocklist(["bad.example"], null);
  const { findings } = checkBioLinks("dm me at b​ad[.]example now", blocklist, configWith());
  assertEquals(findings.length, 1);
  assertEquals(findings[0].matchedDomain, "bad.example");
  assertEquals(findings[0].rule, "blocklist");
});

Deno.test("an empty blocklist finds nothing — link enforcement is inert by default", () => {
  const blocklist = new Blocklist([], null);
  const { findings } = checkBioLinks("https://anything.example.com", blocklist, configWith());
  assertEquals(findings, []);
});

Deno.test("BIO_MAX_LINKS and BIO_BLOCK_INVITES are off unless configured", () => {
  const blocklist = new Blocklist([], null);
  const bio = "a.example.com b.example.com c.example.com d.example.com t.me/+invite";

  assertEquals(checkBioLinks(bio, blocklist, configWith()).findings, []);

  const strict = configWith({ BIO_MAX_LINKS: "3", BIO_BLOCK_INVITES: "true" });
  const rules = checkBioLinks(bio, blocklist, strict).findings.map((f) => f.rule);
  assert(rules.includes("bio_max_links"));
  assert(rules.includes("bio_invite"));
});
