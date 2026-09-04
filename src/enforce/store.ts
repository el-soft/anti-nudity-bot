// Cross-invocation key/value storage: Netlify Blobs, with a per-isolate Map when
// Blobs is unavailable.
//
// The fallback is genuinely weaker — it is lost on every isolate recycle — but it
// is never wrong in the dangerous direction: a lost verdict means a rescan, not a
// wrongly trusted account, and a lost ban counter means the circuit breaker is
// stricter than configured rather than looser.

import { errText, warn } from "../log.ts";

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  readonly backend: "blobs" | "memory";
}

class MemoryStore implements Store {
  readonly backend = "memory" as const;
  #map = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#map.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    // Bounded so a long-lived isolate under a join flood cannot grow without
    // limit. Eviction order is insertion order, which is close enough to LRU for
    // a cache whose entries all expire on a timer anyway.
    if (this.#map.size > 5000) {
      for (const oldest of this.#map.keys()) {
        this.#map.delete(oldest);
        if (this.#map.size <= 4000) break;
      }
    }
    this.#map.set(key, value);
    return Promise.resolve();
  }
}

class BlobsStore implements Store {
  readonly backend = "blobs" as const;
  // deno-lint-ignore no-explicit-any
  #store: any;
  #fallback = new MemoryStore();

  // deno-lint-ignore no-explicit-any
  constructor(store: any) {
    this.#store = store;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.#store.get(key, { type: "text" }) ?? null;
    } catch (e) {
      warn({ event: "cache_unavailable", op: "get", error: errText(e) });
      return await this.#fallback.get(key);
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.#store.set(key, value);
    } catch (e) {
      warn({ event: "cache_unavailable", op: "set", error: errText(e) });
      await this.#fallback.set(key, value);
    }
  }
}

let storePromise: Promise<Store> | null = null;

export function getStore(name = "nudity-detector-bot"): Promise<Store> {
  return (storePromise ??= (async () => {
    try {
      const blobs = await import("@netlify/blobs");
      const store = blobs.getStore({ name, consistency: "strong" });
      return new BlobsStore(store);
    } catch (e) {
      warn({ event: "blobs_unavailable", error: errText(e), fallback: "memory" });
      return new MemoryStore();
    }
  })());
}
