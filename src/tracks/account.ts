// Track B — is this account an explicit-content or scam account?
//
// Examines the profile photo and the bio. Its action is a ban, so every failure
// path here resolves to "no verdict" rather than to a violation: an inability to
// check never justifies enforcement.

import type { Config } from "../config.ts";
import { classifyImage } from "../detector/classify.ts";
import type { Finding } from "../enforce/actions.ts";
import { type CacheEntry, isFresh, readVerdict, writeVerdict } from "../enforce/cache.ts";
import { checkBioLinks, checkSafeBrowsing } from "../links/blocklist.ts";
import type { Blocklist } from "../links/blocklist.ts";
import { debug, info } from "../log.ts";
import type { ApiResult, TelegramClient } from "../telegram/api.ts";
import type { PhotoSize } from "../telegram/types.ts";

export interface AccountScan {
  verdict: "clean" | "flagged" | "unavailable";
  finding: Finding | null;
  cache: "hit" | "miss" | "stale";
  ms: Record<string, number>;
  /** Set when the photo could not be judged, for the log line. */
  note?: string;
}

/** Largest size of a profile photo that fits the download cap. */
function pickSize(sizes: PhotoSize[], maxBytes: number): PhotoSize | null {
  let best: PhotoSize | null = null;
  for (const size of sizes) {
    if (size.file_size !== undefined && size.file_size > maxBytes) continue;
    if (!best || size.width * size.height > best.width * best.height) best = size;
  }
  return best;
}

function entryFrom(scan: AccountScan): CacheEntry {
  return {
    verdict: scan.verdict,
    score: scan.finding?.score ?? null,
    reason: scan.finding?.reason ?? null,
    photoFileUniqueId: scan.finding?.photoFileUniqueId ?? null,
    checkedAt: Math.floor(Date.now() / 1000),
  };
}

export async function scanAccount(
  client: TelegramClient,
  config: Config,
  blocklist: Blocklist,
  userId: number,
): Promise<AccountScan> {
  const ms: Record<string, number> = {};

  const cached = await readVerdict(userId);
  if (cached && isFresh(cached, config)) {
    return {
      verdict: cached.verdict,
      cache: "hit",
      ms,
      finding: cached.verdict === "flagged"
        ? {
          reason: (cached.reason as Finding["reason"]) ?? "profile_nsfw",
          score: cached.score,
          className: null,
          photoFileUniqueId: cached.photoFileUniqueId,
          matchedDomain: null,
        }
        : null,
    };
  }

  const scan = await runScan(client, config, blocklist, userId, cached, ms);
  await writeVerdict(userId, entryFrom(scan));
  return scan;
}

async function runScan(
  client: TelegramClient,
  config: Config,
  blocklist: Blocklist,
  userId: number,
  cached: CacheEntry | null,
  ms: Record<string, number>,
): Promise<AccountScan> {
  const cache: AccountScan["cache"] = cached ? "stale" : "miss";
  const notes: string[] = [];
  let sawSomething = false;

  // --- bio and links -------------------------------------------------------
  const bioStarted = Date.now();
  const chat = await client.getChat(userId);
  ms.profile_fetch = Date.now() - bioStarted;

  if (chat.ok) {
    const bio = chat.value.bio ?? chat.value.description ?? "";
    if (bio) {
      sawSomething = true;
      await blocklist.ensureLoaded();
      const { links, findings } = checkBioLinks(bio, blocklist, config);

      let finding = findings[0] ?? null;
      if (!finding && config.safeBrowsingApiKey && links.length > 0) {
        // Only unknown hosts, and only when the operator opted in: this is the
        // one check that sends anything derived from user content off-box.
        const hosts = links.map((link) => link.host).filter((host) => !blocklist.match(host));
        const safeBrowsing = await checkSafeBrowsing(hosts, config.safeBrowsingApiKey);
        if (safeBrowsing) finding = safeBrowsing;
      }

      if (finding) {
        return {
          verdict: "flagged",
          cache,
          ms,
          finding: {
            reason: "harmful_link",
            score: null,
            className: null,
            photoFileUniqueId: null,
            matchedDomain: finding.matchedDomain,
          },
          note: `rule:${finding.rule}`,
        };
      }
    }
  } else {
    // The bot cannot resolve every stranger — "chat not found" is common for an
    // account it has never shared context with, and especially on a join request.
    notes.push("bio_unavailable");
    debug({ event: "get_chat_failed", user_id: userId, error: chat.error });
  }

  // --- profile photo -------------------------------------------------------
  const photosStarted = Date.now();
  const photos = await client.getUserProfilePhotos(userId, config.profileScanDepth);
  ms.photos_fetch = Date.now() - photosStarted;

  if (!photos.ok) {
    notes.push("profile_photo_unavailable");
    info({ event: "profile_photo_unavailable", user_id: userId, error: photos.error });
    return finish(sawSomething, cache, ms, notes);
  }

  if (photos.value.total_count === 0 || photos.value.photos.length === 0) {
    // Absence of a signal is not a violation. This is also the obvious evasion:
    // an account with a hidden avatar can only be judged on its bio.
    notes.push("no_profile_photo");
    return finish(sawSomething, cache, ms, notes);
  }

  for (const sizes of photos.value.photos.slice(0, config.profileScanDepth)) {
    const size = pickSize(sizes, config.maxFileBytes);
    if (!size) {
      notes.push("photo_too_large");
      continue;
    }

    // The avatar is provably the same file the last scan already judged clean, so
    // there is nothing new to classify even though the TTL expired.
    if (cached?.photoFileUniqueId === size.file_unique_id && cached.verdict === "clean") {
      debug({ event: "avatar_unchanged", user_id: userId });
      sawSomething = true;
      continue;
    }

    const downloadStarted = Date.now();
    const file: ApiResult<{ bytes: Uint8Array }> = await client.download(size.file_id);
    ms.download = (ms.download ?? 0) + (Date.now() - downloadStarted);
    if (!file.ok) {
      notes.push(file.error.startsWith("too_large") ? "photo_too_large" : "download_failed");
      info({ event: "profile_download_failed", user_id: userId, error: file.error });
      continue;
    }

    const outcome = await classifyImage(file.value.bytes, config);
    if (!outcome.ok) {
      // Model failure, decode failure, unsupported format — all "no verdict".
      notes.push(outcome.reason);
      info({
        event: "profile_classify_failed",
        user_id: userId,
        reason: outcome.reason,
        detail: outcome.detail,
      });
      continue;
    }

    sawSomething = true;
    ms.decode = (ms.decode ?? 0) + outcome.ms.decode;
    ms.classify = (ms.classify ?? 0) + outcome.ms.classify;
    ms.model_load = outcome.ms.modelLoad;

    const { score, topClass, scores } = outcome.classification;
    debug({ event: "profile_scores", user_id: userId, scores });

    if (score >= config.profileNsfwThreshold) {
      return {
        verdict: "flagged",
        cache,
        ms,
        finding: {
          reason: "profile_nsfw",
          score,
          className: topClass,
          photoFileUniqueId: size.file_unique_id,
          matchedDomain: null,
        },
      };
    }
  }

  return finish(sawSomething, cache, ms, notes);
}

function finish(
  sawSomething: boolean,
  cache: AccountScan["cache"],
  ms: Record<string, number>,
  notes: string[],
): AccountScan {
  // "Clean" is only claimed when something was actually examined. Otherwise the
  // verdict is `unavailable`, which caches briefly and never reads as trusted.
  return {
    verdict: sawSomething ? "clean" : "unavailable",
    finding: null,
    cache,
    ms,
    note: notes.length > 0 ? notes.join(",") : undefined,
  };
}
