import { assert, assertEquals } from "@std/assert";
import { resize, type RgbImage, sniffFormat } from "../src/detector/decode.ts";
import { isFlagged, scoreOf } from "../src/detector/classify.ts";
import { isFresh } from "../src/enforce/cache.ts";
import { parseConfig } from "../src/config.ts";

const config = parseConfig((key) =>
  ({
    TELEGRAM_BOT_TOKEN: "1:a",
    TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
    ALLOWED_CHAT_IDS: "-100",
  } as Record<string, string>)[key]
).config;

Deno.test("formats are identified by magic bytes, not by extension or MIME", () => {
  const header = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(12).fill(0)]);
  assertEquals(sniffFormat(header(0xff, 0xd8, 0xff)), "jpeg");
  assertEquals(sniffFormat(header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "png");
  assertEquals(sniffFormat(header(0x47, 0x49, 0x46)), "gif");
  assertEquals(sniffFormat(header(0x42, 0x4d)), "bmp");

  const webp = new Uint8Array(16);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assertEquals(sniffFormat(webp), "webp");

  assertEquals(sniffFormat(new Uint8Array([1, 2, 3])), "unknown");
  assertEquals(sniffFormat(new Uint8Array(16)), "unknown");
});

Deno.test("resize produces the model's input shape and preserves flat colour", () => {
  const source: RgbImage = { data: new Uint8Array(30 * 20 * 3).fill(128), width: 30, height: 20 };
  const out = resize(source, 224);
  assertEquals(out.width, 224);
  assertEquals(out.height, 224);
  assertEquals(out.data.length, 224 * 224 * 3);
  assert(out.data.every((v) => v === 128));
});

Deno.test("resize interpolates rather than clipping at the edges", () => {
  // A two-pixel horizontal gradient upscaled must stay monotonic across the row.
  const data = new Uint8Array([0, 0, 0, 255, 255, 255]);
  const out = resize({ data, width: 2, height: 1 }, 8);
  const row = Array.from({ length: 8 }, (_, x) => out.data[x * 3]);
  for (let i = 1; i < row.length; i++) assert(row[i] >= row[i - 1]);
  assertEquals(row[0], 0);
  assertEquals(row[7], 255);
});

Deno.test("the score is the max over the selected classes, never a sum", () => {
  const scores = { Porn: 0.3, Hentai: 0.35, Sexy: 0.3, Neutral: 0.05 };
  const result = scoreOf(scores, ["Porn", "Hentai", "Sexy"]);
  // Summing would give 0.95 and flag this; max gives 0.35 and does not.
  assertEquals(result.score, 0.35);
  assertEquals(result.topClass, "Hentai");
  assert(!isFlagged(result.score, 0.7));
});

Deno.test("a missing class scores zero rather than undefined", () => {
  assertEquals(scoreOf({ Neutral: 0.9 }, ["Porn", "Hentai"]).score, 0);
});

Deno.test("the threshold is inclusive", () => {
  assert(isFlagged(0.7, 0.7));
  assert(!isFlagged(0.6999, 0.7));
});

Deno.test("an unavailable verdict expires far sooner than a real one", () => {
  const now = Date.now();
  const at = (secondsAgo: number) => Math.floor(now / 1000) - secondsAgo;

  const clean = {
    verdict: "clean" as const,
    score: 0.1,
    reason: null,
    photoFileUniqueId: null,
    checkedAt: at(3600),
  };
  assert(isFresh(clean, config, now), "a clean verdict lasts PROFILE_CACHE_TTL_SECONDS");

  const unavailable = { ...clean, verdict: "unavailable" as const };
  assert(
    !isFresh(unavailable, config, now),
    "an absent signal is not a judgement and must be retried",
  );

  const stale = { ...clean, checkedAt: at(config.profileCacheTtlSeconds + 1) };
  assert(!isFresh(stale, config, now));
});
