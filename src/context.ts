// Everything enforcement needs, built once per cold start.

import { type Config, parseConfig } from "./config.ts";
import { error, info, warn } from "./log.ts";
import { RemovalBudget } from "./enforce.ts";
import { TelegramClient } from "./telegram/api.ts";

export interface Context {
  config: Config;
  client: TelegramClient;
  /** Shared by every update this isolate handles, which is the point of it. */
  budget: RemovalBudget;
  /** The bot's own account id, resolved lazily from getMe and cached per isolate. */
  selfId(): Promise<number | null>;
}

export interface Runtime {
  context: Context | null;
  /** Non-empty means the deployment is misconfigured and nothing is enforced. */
  fatal: string[];
}

let selfPromise: Promise<number | null> | null = null;

export function buildRuntime(get: (key: string) => string | undefined): Runtime {
  const { config, fatal, warnings } = parseConfig(get);

  for (const detail of warnings) warn({ event: "config_warning", detail });
  for (const detail of fatal) error({ event: "config_error", detail });

  if (fatal.length > 0) {
    error({
      event: "startup_refused",
      detail: "configuration is invalid; every update will be acknowledged and dropped",
      problems: fatal.length,
    });
    return { context: null, fatal };
  }

  info({
    event: "startup",
    dry_run: config.dryRun,
    chats: config.allowedChatIds.size,
    allow_invite_link_joins: config.allowInviteLinkJoins,
    remove_undisclosed_joins: config.removeUndisclosedJoins,
    join_request_action: config.joinRequestAction,
    max_removals_per_hour: config.maxRemovalsPerHour,
    log_level: config.logLevel,
  });

  const client = new TelegramClient(config.botToken);

  const selfId = () => (selfPromise ??= client.getMe().then((result) => {
    if (!result.ok) {
      // Without it the bot cannot recognise its own actions, and the loop guard
      // in the policy is what depends on that. Recoverable: the next request
      // retries.
      error({ event: "get_me_failed", error: result.error });
      selfPromise = null;
      return null;
    }
    info({ event: "identified", bot_id: result.value.id, username: result.value.username });
    return result.value.id;
  }));

  return {
    context: { config, client, budget: new RemovalBudget(config.maxRemovalsPerHour), selfId },
    fatal: [],
  };
}
