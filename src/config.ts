// Environment parsing and validation, done once per cold start.
//
// Nothing here throws. A bad value becomes a `fatal` entry and the webhook then
// answers 200 and processes nothing — failing closed, but without turning every
// delivery into a Telegram retry. See ARCHITECTURE.md § Configuration surface.

import { type Level, setLogLevel } from "./log.ts";

export type NsfwClass = "Drawing" | "Hentai" | "Neutral" | "Porn" | "Sexy";
export type MediaType = "photo" | "sticker" | "document" | "video_thumbnail";
export type MessageAction = "warn" | "warn_and_delete" | "delete" | "log";
export type BanScope = "this_chat" | "all_chats";
export type ForwardOriginAction = "delete" | "delete_and_ban" | "ignore";
export type EnforcementReason = "profile_nsfw" | "harmful_link" | "message_nsfw";

export interface Config {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: Set<number>;
  dryRun: boolean;

  // Track B — the account
  scanProfile: boolean;
  scanOnJoin: boolean;
  scanJoinRequests: boolean;
  approveCleanJoinRequests: boolean;
  deleteJoinNotice: boolean;
  profileNsfwThreshold: number;
  profileScanDepth: number;
  enforcementReasons: Set<EnforcementReason>;
  linkBlocklist: string[];
  linkBlocklistUrl: string | null;
  bioMaxLinks: number | null;
  bioBlockInvites: boolean;
  safeBrowsingApiKey: string | null;
  revokeMessages: boolean;
  banScope: BanScope;
  profileCacheTtlSeconds: number;
  scanBots: boolean;
  forwardOriginAction: ForwardOriginAction;
  scanCommand: boolean;

  // Track A — message media
  nsfwThreshold: number;
  nsfwClasses: NsfwClass[];
  messageAction: MessageAction;
  warningMessage: string;
  scanMediaTypes: Set<MediaType>;
  maxFileBytes: number;

  // Safety rails
  exemptUserIds: Set<number>;
  exemptJoinedBefore: number | null; // unix seconds
  maxBansPerHour: number;
  adminAlertChatId: number | null;
  leaveUnlistedChats: boolean;

  // Model hosting
  modelBaseUrl: string | null;
  tfjsWasmBaseUrl: string | null;

  logLevel: Level;
}

export interface LoadedConfig {
  config: Config;
  /** Non-empty means the deployment is misconfigured; nothing will be processed. */
  fatal: string[];
  /** Worth an operator's attention, but the bot still runs. */
  warnings: string[];
}

type Getter = (key: string) => string | undefined;

const ALL_CLASSES: NsfwClass[] = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"];
const ALL_MEDIA: MediaType[] = ["photo", "sticker", "document", "video_thumbnail"];
const ALL_REASONS: EnforcementReason[] = ["profile_nsfw", "harmful_link", "message_nsfw"];

function list(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseConfig(get: Getter): LoadedConfig {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const str = (key: string, fallback = ""): string => get(key)?.trim() || fallback;

  const bool = (key: string, fallback: boolean): boolean => {
    const raw = get(key)?.trim().toLowerCase();
    if (raw === undefined || raw === "") return fallback;
    if (["true", "1", "yes", "on"].includes(raw)) return true;
    if (["false", "0", "no", "off"].includes(raw)) return false;
    fatal.push(`${key}: expected true or false, got "${raw}"`);
    return fallback;
  };

  const num = (
    key: string,
    fallback: number,
    { min, max, integer }: { min?: number; max?: number; integer?: boolean } = {},
  ): number => {
    const raw = get(key)?.trim();
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      fatal.push(`${key}: expected a number, got "${raw}"`);
      return fallback;
    }
    if (integer && !Number.isInteger(value)) {
      fatal.push(`${key}: expected a whole number, got "${raw}"`);
      return fallback;
    }
    if (min !== undefined && value < min) {
      fatal.push(`${key}: must be >= ${min}, got ${value}`);
      return fallback;
    }
    if (max !== undefined && value > max) {
      fatal.push(`${key}: must be <= ${max}, got ${value}`);
      return fallback;
    }
    return value;
  };

  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = get(key)?.trim();
    if (!raw) return fallback;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    fatal.push(`${key}: expected one of ${allowed.join(", ")}, got "${raw}"`);
    return fallback;
  };

  const someOf = <T extends string>(key: string, allowed: readonly T[], fallback: T[]): T[] => {
    const raw = list(get(key));
    if (raw.length === 0) return fallback;
    const out: T[] = [];
    for (const item of raw) {
      if ((allowed as readonly string[]).includes(item)) out.push(item as T);
      else fatal.push(`${key}: unknown value "${item}" (allowed: ${allowed.join(", ")})`);
    }
    return out;
  };

  const ids = (key: string): Set<number> => {
    const out = new Set<number>();
    for (const item of list(get(key))) {
      const value = Number(item);
      if (!Number.isSafeInteger(value) || value === 0) {
        fatal.push(`${key}: "${item}" is not a valid Telegram ID`);
        continue;
      }
      out.add(value);
    }
    return out;
  };

  const logLevel = oneOf<Level>("LOG_LEVEL", ["debug", "info", "warn", "error"], "info");
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
    // Not fatal: an operator may legitimately be mid-setup. But the bot does
    // nothing at all in this state, which is almost never what was intended.
    warnings.push("ALLOWED_CHAT_IDS is empty — every update will be dropped");
  }

  const nsfwThreshold = num("NSFW_THRESHOLD", 0.7, { min: 0, max: 1 });
  const profileNsfwThreshold = num("PROFILE_NSFW_THRESHOLD", 0.9, { min: 0, max: 1 });
  if (profileNsfwThreshold < nsfwThreshold) {
    fatal.push(
      `PROFILE_NSFW_THRESHOLD (${profileNsfwThreshold}) is below NSFW_THRESHOLD ` +
        `(${nsfwThreshold}): that bans on weaker evidence than it warns on`,
    );
  }

  const maxBansPerHour = num("MAX_BANS_PER_HOUR", 10, { min: 0, integer: true });
  if (maxBansPerHour === 0) {
    fatal.push("MAX_BANS_PER_HOUR=0 is ambiguous; use DRY_RUN=true to disable enforcement");
  }

  let exemptJoinedBefore: number | null = null;
  const joinedBeforeRaw = str("EXEMPT_JOINED_BEFORE");
  if (joinedBeforeRaw) {
    const parsed = Date.parse(joinedBeforeRaw);
    if (Number.isNaN(parsed)) fatal.push(`EXEMPT_JOINED_BEFORE: not a date: "${joinedBeforeRaw}"`);
    else exemptJoinedBefore = Math.floor(parsed / 1000);
  }

  const adminAlertRaw = str("ADMIN_ALERT_CHAT_ID");
  let adminAlertChatId: number | null = null;
  if (adminAlertRaw) {
    const value = Number(adminAlertRaw);
    if (!Number.isSafeInteger(value) || value === 0) {
      fatal.push(`ADMIN_ALERT_CHAT_ID: not a valid chat ID: "${adminAlertRaw}"`);
    } else adminAlertChatId = value;
  }

  const enforcementReasons = new Set(
    someOf<EnforcementReason>("ENFORCEMENT_REASONS", ALL_REASONS, [
      "profile_nsfw",
      "harmful_link",
    ]),
  );

  const linkBlocklist = list(get("LINK_BLOCKLIST")).map((d) => d.toLowerCase());
  const linkBlocklistUrl = str("LINK_BLOCKLIST_URL") || null;
  if (
    enforcementReasons.has("harmful_link") && linkBlocklist.length === 0 && !linkBlocklistUrl &&
    !str("SAFE_BROWSING_API_KEY")
  ) {
    warnings.push(
      "harmful_link is in ENFORCEMENT_REASONS but no blocklist is configured — link enforcement is inert",
    );
  }

  const bioMaxLinksRaw = str("BIO_MAX_LINKS");
  const bioMaxLinks = bioMaxLinksRaw ? num("BIO_MAX_LINKS", 3, { min: 0, integer: true }) : null;

  const nsfwClasses = someOf<NsfwClass>("NSFW_CLASSES", ALL_CLASSES, ["Porn", "Hentai"]);
  if (nsfwClasses.length === 0) {
    fatal.push("NSFW_CLASSES resolved to nothing — no image could ever be flagged");
  }
  if (nsfwClasses.includes("Neutral")) {
    warnings.push("NSFW_CLASSES includes Neutral — this flags ordinary images");
  }
  if (nsfwClasses.includes("Sexy") && enforcementReasons.has("profile_nsfw")) {
    warnings.push(
      "NSFW_CLASSES includes Sexy while profile_nsfw enforces — swimwear avatars can earn a ban",
    );
  }

  const config: Config = {
    botToken,
    webhookSecret,
    allowedChatIds,
    dryRun: bool("DRY_RUN", true),

    scanProfile: bool("SCAN_PROFILE", true),
    scanOnJoin: bool("SCAN_ON_JOIN", true),
    scanJoinRequests: bool("SCAN_JOIN_REQUESTS", true),
    approveCleanJoinRequests: bool("APPROVE_CLEAN_JOIN_REQUESTS", false),
    deleteJoinNotice: bool("DELETE_JOIN_NOTICE", true),
    profileNsfwThreshold,
    profileScanDepth: num("PROFILE_SCAN_DEPTH", 1, { min: 1, max: 10, integer: true }),
    enforcementReasons,
    linkBlocklist,
    linkBlocklistUrl,
    bioMaxLinks,
    bioBlockInvites: bool("BIO_BLOCK_INVITES", false),
    safeBrowsingApiKey: str("SAFE_BROWSING_API_KEY") || null,
    revokeMessages: bool("REVOKE_MESSAGES", true),
    banScope: oneOf<BanScope>("BAN_SCOPE", ["this_chat", "all_chats"], "this_chat"),
    profileCacheTtlSeconds: num("PROFILE_CACHE_TTL_SECONDS", 86400, { min: 60, integer: true }),
    scanBots: bool("SCAN_BOTS", false),
    scanCommand: bool("SCAN_COMMAND", true),
    forwardOriginAction: oneOf<ForwardOriginAction>(
      "FORWARD_ORIGIN_ACTION",
      ["delete", "delete_and_ban", "ignore"],
      "delete",
    ),

    nsfwThreshold,
    nsfwClasses,
    messageAction: oneOf<MessageAction>(
      "MESSAGE_ACTION",
      ["warn", "warn_and_delete", "delete", "log"],
      "warn",
    ),
    warningMessage: str("WARNING_MESSAGE", "⚠️ This image was flagged as adult content."),
    scanMediaTypes: new Set(someOf<MediaType>("SCAN_MEDIA_TYPES", ALL_MEDIA, ALL_MEDIA)),
    maxFileBytes: num("MAX_FILE_BYTES", 5_242_880, { min: 1, max: 20_971_520, integer: true }),

    exemptUserIds: ids("EXEMPT_USER_IDS"),
    exemptJoinedBefore,
    maxBansPerHour,
    adminAlertChatId,
    leaveUnlistedChats: bool("LEAVE_UNLISTED_CHATS", true),

    modelBaseUrl: str("MODEL_BASE_URL") || null,
    tfjsWasmBaseUrl: str("TFJS_WASM_BASE_URL") || null,

    logLevel,
  };

  return { config, fatal, warnings };
}
