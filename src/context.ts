// Everything a handler needs, built once per cold start.

import { type Config, parseConfig } from "./config.ts";
import { error, info, warn } from "./log.ts";
import { Blocklist } from "./links/blocklist.ts";
import { TelegramClient } from "./telegram/api.ts";

export interface Self {
  id: number;
  username: string | null;
}

export interface Context {
  config: Config;
  client: TelegramClient;
  blocklist: Blocklist;
  /** The bot's own identity, resolved lazily from getMe and cached per isolate. */
  self(): Promise<Self | null>;
  /** Convenience for the many callers that only need the ID. */
  selfId(): Promise<number | null>;
}

export interface Runtime {
  context: Context | null;
  /** Non-empty means the deployment is misconfigured and nothing is processed. */
  fatal: string[];
}

let selfPromise: Promise<Self | null> | null = null;

export function buildRuntime(get: (key: string) => string | undefined): Runtime {
  const { config, fatal, warnings } = parseConfig(get);

  for (const message of warnings) warn({ event: "config_warning", detail: message });
  for (const message of fatal) error({ event: "config_error", detail: message });

  if (fatal.length > 0) {
    error({
      event: "startup_refused",
      detail: "configuration is invalid; every update will be acknowledged and dropped",
      problems: fatal.length,
    });
    return { context: null, fatal };
  }

  const client = new TelegramClient(config.botToken, config.maxFileBytes);
  const blocklist = new Blocklist(config.linkBlocklist, config.linkBlocklistUrl);

  info({
    event: "startup",
    dry_run: config.dryRun,
    chats: config.allowedChatIds.size,
    scan_profile: config.scanProfile,
    enforcement_reasons: [...config.enforcementReasons],
    message_action: config.messageAction,
    ban_scope: config.banScope,
    log_level: config.logLevel,
  });

  const self = () => (selfPromise ??= client.getMe().then((result) => {
    if (!result.ok) {
      // Without it the bot cannot recognise its own messages or joins, so it is
      // worth an error line — but it is recoverable, and the next request
      // retries.
      error({ event: "get_me_failed", error: result.error });
      selfPromise = null;
      return null;
    }
    info({ event: "identified", bot_id: result.value.id, username: result.value.username });
    return { id: result.value.id, username: result.value.username ?? null };
  }));

  return {
    context: {
      config,
      client,
      blocklist,
      self,
      selfId: () => self().then((it) => it?.id ?? null),
    },
    fatal: [],
  };
}
