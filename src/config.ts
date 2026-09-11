// Environment parsing and validation, done once per cold start.
//
// Nothing here throws. A bad value becomes a `fatal` entry and the webhook then
// answers 200 and enforces nothing — failing closed, but without turning every
// delivery into a Telegram retry.

import { type Level, setLogLevel } from "./log.ts";

export type JoinRequestAction = "ignore" | "decline";

export interface Config {
  botToken: string;
  /** Shared secret Telegram sends back on every delivery. */
  webhookSecret: string;
  /** Nothing is enforced in a chat that is not named here. */
  allowedChatIds: Set<number>;
  /** Decide and log, but call nothing that changes a chat. */
  dryRun: boolean;

  /** An invite-link join counts as invited rather than as walking in unaided. */
  allowInviteLinkJoins: boolean;
  /** Act on service-message joins, whose route Telegram does not disclose. */
  removeUndisclosedJoins: boolean;
  joinRequestAction: JoinRequestAction;

  /** Never removed, whatever they do. */
  exemptUserIds: Set<number>;
  /** Circuit breaker: a bug or a raid cannot empty the chat. */
  maxRemovalsPerHour: number;

  logLevel: Level;
}

export interface LoadedConfig {
  config: Config;
  /** Non-empty means the deployment is misconfigured; nothing will be enforced. */
  fatal: string[];
  /** Worth an operator's attention, but the bot still runs. */
  warnings: string[];
}

type Getter = (key: string) => string | undefined;

const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

export function parseConfig(get: Getter): LoadedConfig {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const str = (key: string): string => get(key)?.trim() ?? "";

  const bool = (key: string, fallback: boolean): boolean => {
    const raw = str(key).toLowerCase();
    if (raw === "") return fallback;
    if (["true", "1", "yes", "on"].includes(raw)) return true;
    if (["false", "0", "no", "off"].includes(raw)) return false;
    fatal.push(`${key}: expected true or false, got "${raw}"`);
    return fallback;
  };

  const int = (key: string, fallback: number, min: number): number => {
    const raw = str(key);
    if (raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      fatal.push(`${key}: expected a whole number, got "${raw}"`);
      return fallback;
    }
    if (value < min) {
      fatal.push(`${key}: must be >= ${min}, got ${value}`);
      return fallback;
    }
    return value;
  };

  const ids = (key: string): Set<number> => {
    const out = new Set<number>();
    for (const item of str(key).split(",").map((s) => s.trim()).filter(Boolean)) {
      const value = Number(item);
      if (!Number.isSafeInteger(value) || value === 0) {
        fatal.push(`${key}: "${item}" is not a valid Telegram ID`);
        continue;
      }
      out.add(value);
    }
    return out;
  };

  const logLevelRaw = str("LOG_LEVEL");
  let logLevel: Level = "info";
  if (logLevelRaw) {
    if ((LEVELS as readonly string[]).includes(logLevelRaw)) logLevel = logLevelRaw as Level;
    else fatal.push(`LOG_LEVEL: expected one of ${LEVELS.join(", ")}, got "${logLevelRaw}"`);
  }
  setLogLevel(logLevel);

  const botToken = str("TELEGRAM_BOT_TOKEN");
  if (!botToken) fatal.push("TELEGRAM_BOT_TOKEN is required");

  const webhookSecret = str("TELEGRAM_WEBHOOK_SECRET");
  if (!webhookSecret) {
    fatal.push("TELEGRAM_WEBHOOK_SECRET is required — without it any caller can post updates");
  } else if (webhookSecret.length < 16) {
    warnings.push("TELEGRAM_WEBHOOK_SECRET is shorter than 16 characters");
  }

  const allowedChatIds = ids("ALLOWED_CHAT_IDS");
  if (allowedChatIds.size === 0) {
    // Not fatal: an operator may legitimately be mid-setup. But the bot enforces
    // nothing at all in this state, which is almost never what was intended.
    warnings.push("ALLOWED_CHAT_IDS is empty — no chat is policed");
  }

  let joinRequestAction: JoinRequestAction = "ignore";
  const requestRaw = str("JOIN_REQUEST_ACTION");
  if (requestRaw) {
    if (requestRaw === "ignore" || requestRaw === "decline") joinRequestAction = requestRaw;
    else fatal.push(`JOIN_REQUEST_ACTION: expected ignore or decline, got "${requestRaw}"`);
  }

  const removeUndisclosedJoins = bool("REMOVE_UNDISCLOSED_JOINS", false);
  const allowInviteLinkJoins = bool("ALLOW_INVITE_LINK_JOINS", true);
  if (removeUndisclosedJoins && allowInviteLinkJoins) {
    warnings.push(
      "REMOVE_UNDISCLOSED_JOINS=true removes service-message joins, whose invite link " +
        "Telegram does not disclose — invited members can be removed despite " +
        "ALLOW_INVITE_LINK_JOINS=true",
    );
  }

  const config: Config = {
    botToken,
    webhookSecret,
    allowedChatIds,
    dryRun: bool("DRY_RUN", true),
    allowInviteLinkJoins,
    removeUndisclosedJoins,
    joinRequestAction,
    exemptUserIds: ids("EXEMPT_USER_IDS"),
    maxRemovalsPerHour: int("MAX_REMOVALS_PER_HOUR", 20, 1),
    logLevel,
  };

  return { config, fatal, warnings };
}
