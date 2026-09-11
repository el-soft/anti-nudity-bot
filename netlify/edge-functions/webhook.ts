// The only entry point.
//
// The whole bot: verify the delivery came from Telegram, name the update, and
// write one log line per event. Telegram is answered as soon as the lines are
// out, because it treats a slow response as a delivery failure and redelivers.

import type { Config as NetlifyConfig } from "@netlify/edge-functions";
import { classify } from "../../src/classify.ts";
import { parseConfig } from "../../src/config.ts";
import { error, info, log, warn } from "../../src/log.ts";
import { SECRET_HEADER, secretMatches } from "../../src/telegram/verify.ts";
import type { Update } from "../../src/telegram/types.ts";

// Parsed and validated once per cold start. An invalid configuration leaves
// `settings` unusable, and every update is then acknowledged and dropped — failing
// closed, without turning each delivery into a Telegram retry.
const { config: settings, fatal, warnings } = parseConfig((key) => Netlify.env.get(key));

for (const detail of warnings) warn({ event: "config_warning", detail });
for (const detail of fatal) error({ event: "config_error", detail });
if (fatal.length === 0) info({ event: "startup", log_level: settings.logLevel });
else {
  error({
    event: "startup_refused",
    detail: "configuration is invalid; every update will be acknowledged and dropped",
    problems: fatal.length,
  });
}

export default (request: Request) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  // Checked before the body is read, and with a length-independent comparison.
  if (!secretMatches(settings.webhookSecret, request.headers.get(SECRET_HEADER))) {
    warn({ event: "rejected", reason: "bad_secret" });
    return new Response("Unauthorized", { status: 401 });
  }

  return handle(request);
};

async function handle(request: Request): Promise<Response> {
  let update: Update;
  try {
    update = await request.json();
  } catch {
    warn({ event: "rejected", reason: "bad_json" });
    return new Response("Bad Request", { status: 400 });
  }

  if (fatal.length > 0) {
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

  for (const event of classify(update)) {
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

  return new Response("OK");
}

export const config: NetlifyConfig = {
  path: "/telegram/webhook",
};
