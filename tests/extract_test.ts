import { assert, assertEquals } from "@std/assert";
import { parseConfig } from "../src/config.ts";
import { extractMedia } from "../src/telegram/extract.ts";
import type { Message, Update } from "../src/telegram/types.ts";

const config = parseConfig((key) =>
  ({
    TELEGRAM_BOT_TOKEN: "1:a",
    TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
    ALLOWED_CHAT_IDS: "-100",
  } as Record<string, string>)[key]
).config;

const photoMessage = (JSON.parse(
  Deno.readTextFileSync(new URL("../fixtures/message_photo.json", import.meta.url)),
) as Update).message!;

const bare = (fields: Partial<Message>): Message => ({
  message_id: 1,
  date: 1,
  chat: { id: -100, type: "supergroup" },
  ...fields,
});

Deno.test("picks the largest photo size that fits the cap", () => {
  const result = extractMedia(photoMessage, config);
  assert(result.found);
  // The 2560px size declares 99 MB and must be passed over, not chosen and then
  // rejected at download time.
  assertEquals(result.media.fileId, "large");
});

Deno.test("an animated sticker falls back to its JPEG thumbnail", () => {
  const message = bare({
    sticker: {
      file_id: "s",
      file_unique_id: "us",
      is_animated: true,
      thumbnail: { file_id: "t", file_unique_id: "ut", width: 128, height: 128 },
    },
  });
  const result = extractMedia(message, config);
  assert(result.found);
  assertEquals(result.media.fileId, "t");
  assert(result.media.thumbnail);
});

Deno.test("an animated sticker with no thumbnail is unsupported, not clean", () => {
  const message = bare({ sticker: { file_id: "s", file_unique_id: "us", is_animated: true } });
  const result = extractMedia(message, config);
  assert(!result.found);
  assertEquals(result.reason, "unsupported_format");
});

Deno.test("non-image documents are ignored", () => {
  const message = bare({
    document: { file_id: "d", file_unique_id: "ud", mime_type: "application/pdf" },
  });
  const result = extractMedia(message, config);
  assert(!result.found);
  assertEquals(result.reason, "no_media");
});

Deno.test("an image document is scanned regardless of what it claims to be", () => {
  const message = bare({
    document: { file_id: "d", file_unique_id: "ud", mime_type: "image/jpeg", file_size: 1000 },
  });
  const result = extractMedia(message, config);
  assert(result.found);
  assertEquals(result.media.mediaType, "document");
  assertEquals(result.media.thumbnail, false);
});

Deno.test("videos are judged by their thumbnail only", () => {
  const message = bare({
    video: {
      file_id: "v",
      file_unique_id: "uv",
      file_size: 900000,
      thumbnail: { file_id: "vt", file_unique_id: "uvt", width: 320, height: 180 },
    },
  });
  const result = extractMedia(message, config);
  assert(result.found);
  assertEquals(result.media.mediaType, "video_thumbnail");
  assert(result.media.thumbnail);
});

Deno.test("SCAN_MEDIA_TYPES narrows what is looked at", () => {
  const narrowed = parseConfig((key) =>
    ({
      TELEGRAM_BOT_TOKEN: "1:a",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
      ALLOWED_CHAT_IDS: "-100",
      SCAN_MEDIA_TYPES: "photo",
    } as Record<string, string>)[key]
  ).config;

  const sticker = bare({ sticker: { file_id: "s", file_unique_id: "us" } });
  const result = extractMedia(sticker, narrowed);
  assert(!result.found);
  assertEquals(result.reason, "media_type_disabled");
  assert(extractMedia(photoMessage, narrowed).found);
});

Deno.test("an oversized photo with no fitting size is reported as too_large", () => {
  const message = bare({
    photo: [{
      file_id: "p",
      file_unique_id: "up",
      width: 4000,
      height: 4000,
      file_size: 99_999_999,
    }],
  });
  const result = extractMedia(message, config);
  assert(!result.found);
  assertEquals(result.reason, "too_large");
});
