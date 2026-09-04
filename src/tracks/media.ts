// Track A — is this picture explicit?
//
// Its action is a warning reply, never a ban, so a false positive costs an
// embarrassing bot message rather than a removed member.

import type { Config } from "../config.ts";
import { classifyImage } from "../detector/classify.ts";
import { debug, info } from "../log.ts";
import type { TelegramClient } from "../telegram/api.ts";
import { extractMedia } from "../telegram/extract.ts";
import type { Message } from "../telegram/types.ts";

export interface MediaScan {
  flagged: boolean;
  score: number | null;
  className: string | null;
  fileUniqueId: string | null;
  skipped: string | null;
  ms: Record<string, number>;
}

const NOTHING: MediaScan = {
  flagged: false,
  score: null,
  className: null,
  fileUniqueId: null,
  skipped: "no_media",
  ms: {},
};

export async function scanMessageMedia(
  client: TelegramClient,
  config: Config,
  message: Message,
): Promise<MediaScan> {
  const extracted = extractMedia(message, config);
  if (!extracted.found) {
    if (extracted.reason !== "no_media") {
      info({
        event: "skipped",
        reason: extracted.reason,
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    }
    return { ...NOTHING, skipped: extracted.reason };
  }

  const media = extracted.media;
  const ms: Record<string, number> = {};

  const downloadStarted = Date.now();
  const file = await client.download(media.fileId);
  ms.download = Date.now() - downloadStarted;

  if (!file.ok) {
    const skipped = file.error.startsWith("too_large") ? "too_large" : "download_failed";
    info({
      event: "skipped",
      reason: skipped,
      chat_id: message.chat.id,
      message_id: message.message_id,
      error: file.error,
    });
    return { ...NOTHING, skipped, fileUniqueId: media.fileUniqueId, ms };
  }

  const outcome = await classifyImage(file.value.bytes, config);
  if (!outcome.ok) {
    // Never "clean": a failed check is its own log line so it stays
    // distinguishable from a classification that actually ran.
    info({
      event: "skipped",
      reason: outcome.reason,
      detail: outcome.detail,
      chat_id: message.chat.id,
      message_id: message.message_id,
      media_type: media.mediaType,
    });
    return { ...NOTHING, skipped: outcome.reason, fileUniqueId: media.fileUniqueId, ms };
  }

  ms.decode = outcome.ms.decode;
  ms.classify = outcome.ms.classify;
  ms.model_load = outcome.ms.modelLoad;

  const { score, topClass, scores } = outcome.classification;
  debug({
    event: "media_scores",
    message_id: message.message_id,
    scores,
    media_type: media.mediaType,
  });

  return {
    flagged: score >= config.nsfwThreshold,
    score,
    className: topClass,
    fileUniqueId: media.fileUniqueId,
    skipped: null,
    ms,
  };
}
