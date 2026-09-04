// Model loading, held in a module-scope promise for the life of the isolate.
//
// Netlify recycles isolates freely, so this is a best-effort cache and never a
// guarantee: budget for a full load on an unknown fraction of requests. That is
// why Telegram is answered before any of this is touched.

import type { Config } from "../config.ts";
import { errText, info, warn } from "../log.ts";

// deno-lint-ignore no-explicit-any
type Tf = any;
// deno-lint-ignore no-explicit-any
type NsfwModel = any;

export interface LoadedModel {
  tf: Tf;
  model: NsfwModel;
  backend: string;
}

/**
 * A single promise, not an awaited value: concurrent requests on the same
 * isolate share one load instead of racing into several. Cleared on rejection so
 * the next request retries rather than inheriting a poisoned cache.
 */
let modelPromise: Promise<LoadedModel> | null = null;

/** Non-zero only on the request that paid for a cold load. */
export let lastLoadMs = 0;

const DEFAULT_WASM_BASE = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/";

async function selectBackend(tf: Tf, config: Config): Promise<string> {
  try {
    const { setWasmPaths } = await import("@tensorflow/tfjs-backend-wasm");
    // `usePlatformFetch` is the load-bearing argument. Without it the backend
    // reaches for `fs.readFile`, which does not exist in the Edge sandbox, and
    // initialisation aborts.
    setWasmPaths(config.tfjsWasmBaseUrl ?? DEFAULT_WASM_BASE, true);
    await tf.setBackend("wasm");
    await tf.ready();
    if (tf.getBackend() === "wasm") return "wasm";
  } catch (e) {
    warn({ event: "wasm_backend_unavailable", error: errText(e) });
  }
  // Pure-JS fallback. Roughly an order of magnitude slower per classification,
  // but it needs nothing from the platform, so it is the safety net rather than
  // a reason to give up on scanning.
  await tf.setBackend("cpu");
  await tf.ready();
  return tf.getBackend();
}

export function getModel(config: Config): Promise<LoadedModel> {
  return (modelPromise ??= (async () => {
    const started = Date.now();
    try {
      const tf = await import("@tensorflow/tfjs");
      const nsfwjs = await import("nsfwjs");
      const backend = await selectBackend(tf, config);
      // No MODEL_BASE_URL: nsfwjs loads the MobileNetV2 weights shipped in its
      // own package, which keeps the deployment free of external dependencies.
      const model = config.modelBaseUrl
        ? await nsfwjs.load(config.modelBaseUrl)
        : await nsfwjs.load();
      lastLoadMs = Date.now() - started;
      info({
        event: "model_loaded",
        backend,
        ms: lastLoadMs,
        source: config.modelBaseUrl ?? "bundled",
      });
      return { tf, model, backend };
    } catch (e) {
      // A broken classifier must never look like a clean verdict, so the failure
      // propagates to the caller, which resolves it to "no verdict".
      modelPromise = null;
      throw e;
    }
  })());
}
