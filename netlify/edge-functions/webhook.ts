// The only entry point.
//
// Steps 1-4 are cheap and synchronous: an update from an unknown chat costs one
// JSON parse and one integer-set lookup. Telegram is answered before any Bot API
// call happens, because it treats a slow response as a delivery failure and
// redelivers — which on a cold start is a retry storm.

import type { Config as NetlifyConfig } from "@netlify/edge-functions";
import { classify } from "../../src/classify.ts";
import { buildRuntime } from "../../src/context.ts";
import { enforce } from "../../src/enforce.ts";
import { errText, info, log, warn } from "../../src/log.ts";
import { decide } from "../../src/policy.ts";
import { SECRET_HEADER, secretMatches } from "../../src/telegram/verify.ts";
import type { Update } from "../../src/telegram/types.ts";

// Parsed and validated once per cold start. An invalid configuration leaves
// `context` null, and every update is then acknowledged and dropped — failing
// closed, without turning each delivery into a Telegram retry.
const runtime = buildRuntime((key) => Netlify.env.get(key));

export default (
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

  return handle(request, netlifyContext);
};

async function handle(
  request: Request,
  netlifyContext: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<Response> {
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

  const events = classify(update);
  for (const event of events) {
    info({
      event: "received",
      update_id: update.update_id,
      message_type: event.messageType,
      chat_id: event.chatId ?? undefined,
      user_id: event.userId ?? undefined,
      message_id: event.messageId,
      chat_type: event.chatType,
      is_bot: event.isBot,
      detail: event.detail,
    });
  }

  // Only a join or a join request can produce an action. A departure, a ban, a
  // promotion and every ordinary message are logged and nothing more, and are
  // not worth an isolate staying alive past the response.
  const actionable = events.filter((e) =>
    e.membership?.route !== undefined || e.messageType === "join_request"
  );
  if (actionable.length === 0) return new Response("OK");

  const work = (async () => {
    const selfId = await context.selfId();
    for (const event of actionable) {
      try {
        await enforce(context, decide(event, context.config, selfId));
      } catch (e) {
        log("error", {
          event: "enforcement_failed",
          update_id: update.update_id,
          message_type: event.messageType,
          chat_id: event.chatId ?? undefined,
          user_id: event.userId ?? undefined,
          error: errText(e),
        });
      }
    }
  })();

  // waitUntil keeps the isolate alive for the ban and the unban after the
  // response has gone out. Without it, a torn-down isolate could ban an account
  // and never reach the unban that keeps them re-addable.
  if (typeof netlifyContext?.waitUntil === "function") {
    netlifyContext.waitUntil(work);
  } else {
    await work;
  }

  return new Response("OK");
}

export const config: NetlifyConfig = {
  path: "/telegram/webhook",
};
