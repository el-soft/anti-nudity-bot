// Environment parsing and validation, done once per cold start.
//
// Nothing here throws. A bad value becomes a `fatal` entry and the webhook then
// answers 200 and logs nothing else — failing closed, but without turning every
// delivery into a Telegram retry.

import { type Level, setLogLevel } from "./log.ts";

export interface Config {
  /** Shared secret Telegram sends back on every delivery. */
  webhookSecret: string;
  logLevel: Level;
}

export interface LoadedConfig {
  config: Config;
  /** Non-empty means the deployment is misconfigured; nothing will be logged. */
  fatal: string[];
  /** Worth an operator's attention, but the bot still runs. */
  warnings: string[];
}

type Getter = (key: string) => string | undefined;

const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

export function parseConfig(get: Getter): LoadedConfig {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const raw = get("LOG_LEVEL")?.trim();
  let logLevel: Level = "info";
  if (raw) {
    if ((LEVELS as readonly string[]).includes(raw)) logLevel = raw as Level;
    else fatal.push(`LOG_LEVEL: expected one of ${LEVELS.join(", ")}, got "${raw}"`);
  }
  setLogLevel(logLevel);

  const webhookSecret = get("TELEGRAM_WEBHOOK_SECRET")?.trim() ?? "";
  if (!webhookSecret) {
    fatal.push("TELEGRAM_WEBHOOK_SECRET is required — without it any caller can post updates");
  } else if (webhookSecret.length < 16) {
    warnings.push("TELEGRAM_WEBHOOK_SECRET is shorter than 16 characters");
  }

  return { config: { webhookSecret, logLevel }, fatal, warnings };
}
