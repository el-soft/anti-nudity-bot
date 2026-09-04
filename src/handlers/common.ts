// The shared shape of "scan one account and act on the verdict", used by both the
// join handler and the message handler.

import type { Context } from "../context.ts";
import { enforce, shouldEnforce } from "../enforce/actions.ts";
import { chatExemption, staticExemption } from "../enforce/exempt.ts";
import { recordMember } from "../enforce/roster.ts";
import { debug, info } from "../log.ts";
import type { Subject, Trigger } from "../telegram/subjects.ts";
import { scanAccount } from "../tracks/account.ts";

export interface AccountOutcome {
  /** True when the account was flagged AND that finding is enforceable. */
  banned: boolean;
  flagged: boolean;
}

export interface AccountCheckOptions {
  trigger: Trigger;
  chatId: number;
  /** The message to delete when enforcing: the offending post or the join notice. */
  messageId: number | null;
  joinedAt?: number;
  /** Join requests are declined, not banned. */
  joinRequest?: boolean;
}

/**
 * Runs Track B against one subject and enforces if the verdict warrants it.
 * Exemptions are checked before any scanning, so an exempt account costs nothing.
 */
export async function checkAccount(
  context: Context,
  subject: Subject,
  options: AccountCheckOptions,
): Promise<AccountOutcome> {
  const { config, client, blocklist } = context;
  const selfId = await context.selfId();

  // Recorded before the exemption checks, and for every account the bot sees as a
  // sender or a joiner — including join requests, which is the earliest an account
  // is ever known. This is the only membership list the bot will ever have (the Bot
  // API offers none), and an exempt account today may not be exempt tomorrow.
  //
  // Forward origins are excluded: they are authors of forwarded content, not
  // members of this chat, so putting them in a chat's roster would mean a sweep
  // trying to ban strangers.
  if (subject.role !== "forward_origin") await recordMember(options.chatId, subject.userId);

  const cheap = staticExemption(subject, config, selfId);
  if (cheap.exempt) {
    debug({
      event: "skipped",
      reason: `exempt:${cheap.reason}`,
      user_id: subject.userId,
      chat_id: options.chatId,
    });
    return { banned: false, flagged: false };
  }

  if (subject.actionable) {
    const inChat = await chatExemption(client, options.chatId, subject, config, options.joinedAt);
    if (inChat.exempt) {
      info({
        event: "skipped",
        reason: `exempt:${inChat.reason}`,
        user_id: subject.userId,
        chat_id: options.chatId,
      });
      return { banned: false, flagged: false };
    }
  }

  const scan = await scanAccount(client, config, blocklist, subject.userId);

  const enforceable = scan.verdict === "flagged" && scan.finding !== null &&
    shouldEnforce(scan.finding.reason, config);

  info({
    event: "verdict",
    chat_id: options.chatId,
    message_id: options.messageId,
    user_id: subject.userId,
    trigger: options.trigger,
    track: "B",
    role: subject.role,
    flagged: scan.verdict === "flagged",
    verdict: scan.verdict,
    score: scan.finding?.score ?? null,
    class: scan.finding?.className ?? null,
    reason: scan.finding?.reason ?? null,
    matched_domain: scan.finding?.matchedDomain ?? null,
    action: enforceable ? "enforce" : "none",
    cache: scan.cache,
    note: scan.note,
    ms: scan.ms,
    dry_run: config.dryRun,
  });

  if (!enforceable || !scan.finding) {
    return { banned: false, flagged: scan.verdict === "flagged" };
  }

  // The origin author of a forward is scannable but not a member of this chat,
  // so there is nothing here to ban. FORWARD_ORIGIN_ACTION decides what that
  // costs the member who forwarded it; the caller handles that.
  if (!subject.actionable && !options.joinRequest) {
    return { banned: false, flagged: true };
  }

  await enforce(client, config, {
    chatId: options.chatId,
    userId: subject.userId,
    trigger: options.trigger,
    finding: scan.finding,
    messageId: options.messageId,
    joinRequest: options.joinRequest,
  });

  return { banned: true, flagged: true };
}
