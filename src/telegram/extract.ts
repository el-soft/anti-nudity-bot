// message -> the one file to scan, or a reason there isn't one.
//
// Track A scans at most one file per update. Every skip has its own reason, so
// "why did nothing happen?" is answerable from the logs alone.

import type { Config, MediaType } from "../config.ts";
import type { Message, PhotoSize } from "./types.ts";

export interface Extracted {
  fileId: string;
  fileUniqueId: string;
  mediaType: MediaType;
  /** True when the bytes are a thumbnail rather than the media itself. */
  thumbnail: boolean;
  declaredSize: number | null;
}

export type ExtractResult =
  | { found: true; media: Extracted }
  | {
    found: false;
    reason: "no_media" | "media_type_disabled" | "too_large" | "unsupported_format";
  };

/** Largest size whose declared file_size fits the cap; sizes ascend. */
function largestFitting(sizes: PhotoSize[], maxBytes: number): PhotoSize | null {
  let best: PhotoSize | null = null;
  for (const size of sizes) {
    if (size.file_size !== undefined && size.file_size > maxBytes) continue;
    if (!best || size.width * size.height > best.width * best.height) best = size;
  }
  return best;
}

function fromPhotoSize(size: PhotoSize, mediaType: MediaType, thumbnail: boolean): Extracted {
  return {
    fileId: size.file_id,
    fileUniqueId: size.file_unique_id,
    mediaType,
    thumbnail,
    declaredSize: size.file_size ?? null,
  };
}

export function extractMedia(message: Message, config: Config): ExtractResult {
  const enabled = (type: MediaType) => config.scanMediaTypes.has(type);
  const max = config.maxFileBytes;

  if (message.photo?.length) {
    if (!enabled("photo")) return { found: false, reason: "media_type_disabled" };
    const size = largestFitting(message.photo, max);
    if (!size) return { found: false, reason: "too_large" };
    return { found: true, media: fromPhotoSize(size, "photo", false) };
  }

  if (message.sticker) {
    if (!enabled("sticker")) return { found: false, reason: "media_type_disabled" };
    const sticker = message.sticker;
    // .tgs is a gzipped Lottie archive and .webm is video; neither is decodable
    // here, so the JPEG thumbnail Telegram generates is the only usable input.
    if (sticker.is_animated || sticker.is_video) {
      if (!sticker.thumbnail) return { found: false, reason: "unsupported_format" };
      return { found: true, media: fromPhotoSize(sticker.thumbnail, "sticker", true) };
    }
    if (sticker.file_size !== undefined && sticker.file_size > max) {
      // Static stickers are WEBP, which has no pure-JS decoder here — the
      // thumbnail is the fallback in both the oversized and the undecodable case.
      if (sticker.thumbnail) {
        return { found: true, media: fromPhotoSize(sticker.thumbnail, "sticker", true) };
      }
      return { found: false, reason: "too_large" };
    }
    return {
      found: true,
      media: {
        fileId: sticker.file_id,
        fileUniqueId: sticker.file_unique_id,
        mediaType: "sticker",
        thumbnail: false,
        declaredSize: sticker.file_size ?? null,
      },
    };
  }

  if (message.document) {
    if (!enabled("document")) return { found: false, reason: "media_type_disabled" };
    const doc = message.document;
    // Documents are pass-through and unre-encoded, so this is the path an
    // adversary would pick. The declared MIME type only decides whether to look;
    // the format sniff later runs on the actual bytes.
    if (!doc.mime_type?.startsWith("image/")) return { found: false, reason: "no_media" };
    if (doc.file_size !== undefined && doc.file_size > max) {
      if (doc.thumbnail) {
        return { found: true, media: fromPhotoSize(doc.thumbnail, "document", true) };
      }
      return { found: false, reason: "too_large" };
    }
    return {
      found: true,
      media: {
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        mediaType: "document",
        thumbnail: false,
        declaredSize: doc.file_size ?? null,
      },
    };
  }

  const video = message.video ?? message.animation;
  if (video) {
    if (!enabled("video_thumbnail")) return { found: false, reason: "media_type_disabled" };
    // Thumbnail only. A partial control: a video with an innocuous first frame
    // passes, and ARCHITECTURE.md says so out loud.
    if (!video.thumbnail) return { found: false, reason: "unsupported_format" };
    return { found: true, media: fromPhotoSize(video.thumbnail, "video_thumbnail", true) };
  }

  return { found: false, reason: "no_media" };
}
