// Who must never be scanned or banned. Checked *before* any scanning, so an
// exempt account costs no API calls and no classification.

import type { Config } from "../config.ts";
import type { TelegramClient } from "../telegram/api.ts";
import type { Subject } from "../telegram/subjects.ts";
import type { ChatMember } from "../telegram/types.ts";
import { debug, errText } from "../log.ts";

export type ExemptReason =
  | "self"
  | "bot_account"
  | "exempt_user_id"
  | "chat_admin"
  | "joined_before"
  | "profile_scan_disabled";

export type ExemptCheck = { exempt: true; reason: ExemptReason } | { exempt: false };

/** The cheap half: no network, so it runs first. */
export function staticExemption(
  subject: Subject,
  config: Config,
  selfId: number | null,
): ExemptCheck {
  if (!config.scanProfile) return { exempt: true, reason: "profile_scan_disabled" };
  if (selfId !== null && subject.userId === selfId) return { exempt: true, reason: "self" };
  if (subject.isBot && !config.scanBots) return { exempt: true, reason: "bot_account" };
  if (config.exemptUserIds.has(subject.userId)) return { exempt: true, reason: "exempt_user_id" };
  return { exempt: false };
}

const ADMIN_STATUSES = new Set(["creator", "administrator"]);

/**
 * The half that needs a call. Admins and the owner cannot be banned by the API
 * anyway; exempting them explicitly is what keeps that from being discovered at
 * the moment of a ban.
 *
 * A failed lookup is *not* treated as an exemption — that would let an API blip
 * disable enforcement — but it is logged, and the caller still has every other
 * safeguard in front of it.
 */
export async function chatExemption(
  client: TelegramClient,
  chatId: number,
  subject: Subject,
  config: Config,
  joinedAt?: number,
  /** An already-fetched membership record, so a caller that needed the status for
   * its own reasons does not pay for a second getChatMember. */
  known?: ChatMember,
): Promise<ExemptCheck> {
  // EXEMPT_JOINED_BEFORE exists for the deploy-into-an-old-group case: Trigger 2
  // scans every existing member the first time they post, and the first days
  // after a deploy are the highest-risk window for false positives.
  if (config.exemptJoinedBefore !== null && joinedAt !== undefined) {
    if (joinedAt < config.exemptJoinedBefore) return { exempt: true, reason: "joined_before" };
  }

  const member = known
    ? ({ ok: true, value: known } as const)
    : await client.getChatMember(chatId, subject.userId);
  if (!member.ok) {
    debug({
      event: "admin_check_failed",
      chat_id: chatId,
      user_id: subject.userId,
      error: member.error,
    });
    return { exempt: false };
  }
  if (ADMIN_STATUSES.has(member.value.status)) return { exempt: true, reason: "chat_admin" };

  if (config.exemptJoinedBefore !== null && joinedAt === undefined) {
    // Telegram does not expose a join date on getChatMember, so for an account
    // whose join this deployment never saw, the rule cannot be evaluated. Erring
    // toward exemption here is deliberate: the whole point of the setting is to
    // protect members whose arrival predates the bot.
    return { exempt: true, reason: "joined_before" };
  }

  return { exempt: false };
}

/** The bot's own rights in a chat, checked at promotion rather than at ban time. */
export async function checkOwnRights(
  client: TelegramClient,
  chatId: number,
  selfId: number,
): Promise<{ ok: boolean; missing: string[] }> {
  try {
    const member = await client.getChatMember(chatId, selfId);
    if (!member.ok) return { ok: false, missing: [`getChatMember failed: ${member.error}`] };
    if (member.value.status !== "administrator") {
      // Without admin status Telegram delivers no chat_member updates at all,
      // which is the single most common reason a join-scanning bot silently does
      // nothing.
      return { ok: false, missing: ["administrator (no join signal without it)"] };
    }
    const missing: string[] = [];
    if (!member.value.can_delete_messages) missing.push("can_delete_messages");
    if (!member.value.can_restrict_members) missing.push("can_restrict_members");
    return { ok: missing.length === 0, missing };
  } catch (e) {
    return { ok: false, missing: [errText(e)] };
  }
}
