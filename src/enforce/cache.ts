// The per-user verdict cache. This is what makes Track B affordable: without it,
// every message from an established member costs a getChat, a getUserProfilePhotos,
// an avatar download and a model run.

import type { Config } from "../config.ts";
import { debug, errText, warn } from "../log.ts";
import { getStore } from "./store.ts";

export type CachedVerdict = "clean" | "flagged" | "unavailable";

export interface CacheEntry {
  verdict: CachedVerdict;
  score: number | null;
  reason: string | null;
  photoFileUniqueId: string | null;
  checkedAt: number; // unix seconds
}

/** An `unavailable` verdict is a transient condition, not a judgement, so it
 * expires far sooner than a real one. */
const UNAVAILABLE_TTL_SECONDS = 900;

const key = (userId: number) => `profile:${userId}`;

export function isFresh(entry: CacheEntry, config: Config, now = Date.now()): boolean {
  const ttl = entry.verdict === "unavailable"
    ? UNAVAILABLE_TTL_SECONDS
    : config.profileCacheTtlSeconds;
  return now / 1000 - entry.checkedAt < ttl;
}

export async function readVerdict(userId: number): Promise<CacheEntry | null> {
  try {
    const store = await getStore();
    const raw = await store.get(key(userId));
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch (e) {
    // Fails open toward doing the work: an unreadable cache means scan, never
    // "assume clean".
    warn({ event: "cache_read_failed", user_id: userId, error: errText(e) });
    return null;
  }
}

export async function writeVerdict(userId: number, entry: CacheEntry): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key(userId), JSON.stringify(entry));
  } catch (e) {
    debug({ event: "cache_write_failed", user_id: userId, error: errText(e) });
  }
}
