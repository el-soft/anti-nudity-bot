// The only entry point.
//
// Steps 1-4 are cheap and synchronous: an update from an unknown chat costs one
// JSON parse and one integer-set lookup. Telegram is answered before any fetch,
// download or classification happens, because it treats a slow response as a
// delivery failure and redelivers — which on a cold start is a retry storm.

import type { Config } from "@netlify/edge-functions";
import { buildRuntime } from "../../src/context.ts";
import { errText, info, log, warn } from "../../src/log.ts";
import { dispatch } from "../../src/router.ts";
import { SECRET_HEADER, secretMatches } from "../../src/telegram/verify.ts";
import type { Update } from "../../src/telegram/types.ts";

// Parsed and validated once per cold start. An invalid configuration leaves
// `context` null, and every update is then acknowledged and dropped — failing
// closed, without turning each delivery into a Telegram retry.
const runtime = buildRuntime((key) => Netlify.env.get(key));

export default async (
  request: Request,
  netlifyContext: { waitUntil?: (p: Promise<unknown>) => void },
) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  // Checked before the body is read, and with a length-independent comparison.
  const expected = runtime.context?.config.webhookSecret ?? "";
  if (!secretMatches(expected, request.headers.get(SECRET_HEADER))) {
    warn({ event: "rejected", reason: "bad_secret" });
    return new Response("Unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = await request.json();
  } catch {
    warn({ event: "rejected", reason: "bad_json" });
    return new Response("Bad Request", { status: 400 });
  }

  const context = runtime.context;
  if (!context) {
    // 200, not 500: a non-2xx makes Telegram retry the same update forever and
    // eventually puts the webhook into an error state. The operator's signal is
    // the config_error lines from startup, not a failing delivery.
    log("error", {
      event: "dropped",
      reason: "invalid_configuration",
      update_id: update.update_id,
    });
    return new Response("OK");
  }

  info({ event: "received", update_id: update.update_id });

  const work = dispatch(context, update).catch((e) => {
    warn({ event: "dispatch_failed", update_id: update.update_id, error: errText(e) });
  });

  // waitUntil keeps the isolate alive for the scan and any enforcement after the
  // response has gone out. Without it, a torn-down isolate could delete a message
  // and never reach the ban.
  if (typeof netlifyContext?.waitUntil === "function") {
    netlifyContext.waitUntil(work);
  } else {
    await work;
  }

  return new Response("OK");
};

export const config: Config = {
  path: "/telegram/webhook",
};
