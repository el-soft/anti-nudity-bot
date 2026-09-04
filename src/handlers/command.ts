// The /scan command: an admin asks the bot to check accounts on demand.
//
// A note on what this can and cannot do. **The Bot API has no method that lists a
// group's members** — `getChatMember` needs a user_id you already hold, and
// `getChatAdministrators` returns only admins. So a bare `/scan` cannot mean "every
// member of this group". It means "every account this bot has seen in this group",
// which is what `enforce/roster.ts` records. The reply says so out loud, because an
// admin who believes they have swept the whole group and has not is worse off than
// one who knows the sweep was partial.

import type { Context } from "../context.ts";
import { enforce, shouldEnforce } from "../enforce/actions.ts";
import { chatExemption, staticExemption } from "../enforce/exempt.ts";
import { forgetMember, listMembers } from "../enforce/roster.ts";
import { debug, info, warn } from "../log.ts";
import { parseCommand, type ScanTarget } from "../telegram/command.ts";
import type { Routed, Subject } from "../telegram/subjects.ts";
import { scanAccount } from "../tracks/account.ts";

/**
 * How many accounts one `/scan` sweep examines. A cold scan is a download plus a
 * classification per account, and an Edge invocation has a deadline — so the sweep
 * is bounded and the reply says how many are left, rather than being silently
 * truncated by a timeout partway through a ban.
 */
const SWEEP_LIMIT = 25;

/** True when this message is a command the bot should act on. */
export async function isCommand(context: Context, routed: Routed): Promise<boolean> {
  if (!routed.message) return false;
  const self = await context.self();
  return parseCommand(routed.message, self?.username ?? null) !== null;
}

export async function handleCommand(context: Context, routed: Routed): Promise<void> {
  const { config, client } = context;
  const message = routed.message!;
  const self = await context.self();
  const parsed = parseCommand(message, self?.username ?? null);
  if (!parsed) return;

  if (parsed.name !== "scan") {
    debug({ event: "command_ignored", name: parsed.name, chat_id: routed.chatId });
    return;
  }

  if (!config.scanCommand) {
    await reply(context, routed, "The /scan command is disabled (SCAN_COMMAND=false).");
    return;
  }

  // Only admins. The command bans people, so this check is the whole security
  // boundary of the feature — and it is a live lookup, not a cached list, so a
  // demoted admin loses access immediately.
  const invoker = message.from;
  if (!invoker) return;
  const member = await client.getChatMember(routed.chatId, invoker.id);
  if (!member.ok) {
    warn({
      event: "scan_command_denied",
      reason: "admin_check_failed",
      chat_id: routed.chatId,
      user_id: invoker.id,
      error: member.error,
    });
    await reply(context, routed, "I couldn't verify that you're an admin, so I won't run that.");
    return;
  }
  if (member.value.status !== "creator" && member.value.status !== "administrator") {
    info({
      event: "scan_command_denied",
      reason: "not_admin",
      chat_id: routed.chatId,
      user_id: invoker.id,
    });
    await reply(context, routed, "Only group admins can run /scan.");
    return;
  }

  info({
    event: "scan_command",
    chat_id: routed.chatId,
    user_id: invoker.id,
    target: parsed.target.kind,
    dry_run: config.dryRun,
  });

  await runScanCommand(context, routed, parsed.target);
}

async function runScanCommand(
  context: Context,
  routed: Routed,
  target: ScanTarget,
): Promise<void> {
  if (target.kind === "error") {
    await reply(context, routed, target.detail);
    return;
  }

  if (target.kind === "user") {
    const result = await scanOne(context, routed, target.userId);
    await reply(context, routed, describeOne(context, target.userId, result));
    return;
  }

  const roster = await listMembers(routed.chatId);
  if (roster.length === 0) {
    await reply(
      context,
      routed,
      "I haven't seen anyone in this group yet, so there's nobody to sweep.\n\n" +
        "Telegram doesn't let bots list a group's members, so I can only check accounts " +
        "I've observed — people who have joined or posted since I was added. Reply to " +
        "someone's message with /scan to check them directly.",
    );
    return;
  }

  const batch = roster.slice(0, SWEEP_LIMIT);
  const counts = { clean: 0, flagged: 0, removed: 0, exempt: 0, unavailable: 0, gone: 0 };

  for (const entry of batch) {
    const result = await scanOne(context, routed, entry.userId);
    counts[result.outcome] += 1;
    if (result.outcome === "flagged" && result.removed) counts.removed += 1;
  }

  const remaining = roster.length - batch.length;
  const lines = [
    context.config.dryRun ? "🧪 Sweep complete (DRY RUN — nobody was removed)" : "Sweep complete",
    "",
    `checked: ${batch.length} of ${roster.length} known accounts`,
    `flagged: ${counts.flagged}${counts.flagged > 0 ? ` (removed: ${counts.removed})` : ""}`,
    `clean: ${counts.clean}`,
    `couldn't check: ${counts.unavailable}`,
    `skipped as exempt: ${counts.exempt}`,
  ];
  if (counts.gone > 0) {
    lines.push(`no longer in the group: ${counts.gone} (removed from my list)`);
  }
  if (remaining > 0) {
    lines.push("", `${remaining} left — run /scan again to continue.`);
  }
  lines.push(
    "",
    "Note: Telegram doesn't let bots list a group's members, so this covers only " +
      "accounts I've seen join or post, not everyone in the group.",
  );

  await reply(context, routed, lines.join("\n"));
}

interface OneResult {
  outcome: "clean" | "flagged" | "exempt" | "unavailable" | "gone";
  removed: boolean;
  detail: string | null;
}

/** Statuses that mean the account is not in this chat right now. */
const ABSENT = new Set(["left", "kicked"]);

/** One account, with the same exemptions, budget and audit trail as any other
 * enforcement — /scan is a different trigger, not a different set of rules. */
async function scanOne(context: Context, routed: Routed, userId: number): Promise<OneResult> {
  const { config, client, blocklist } = context;
  const selfId = await context.selfId();

  const subject: Subject = { userId, isBot: false, actionable: true, role: "sender" };

  const cheap = staticExemption(subject, config, selfId);
  if (cheap.exempt) return { outcome: "exempt", removed: false, detail: cheap.reason };

  // Is this account actually in the chat *now*? The roster records everyone the bot
  // has ever seen, including accounts that have since left and join requests that
  // were never approved. banChatMember would happily ban a non-member, so without
  // this check a sweep pre-emptively bans strangers on the strength of an old
  // sighting — the exact wrong-person failure the rest of the design works to avoid.
  const member = await client.getChatMember(routed.chatId, userId);
  if (!member.ok) {
    return { outcome: "unavailable", removed: false, detail: "membership_unknown" };
  }
  if (ABSENT.has(member.value.status)) {
    await forgetMember(routed.chatId, userId);
    debug({ event: "roster_pruned", chat_id: routed.chatId, user_id: userId });
    return { outcome: "gone", removed: false, detail: member.value.status };
  }

  // Reuses the record just fetched rather than asking again.
  const inChat = await chatExemption(
    client,
    routed.chatId,
    subject,
    config,
    undefined,
    member.value,
  );
  if (inChat.exempt) return { outcome: "exempt", removed: false, detail: inChat.reason };

  // force: an admin running /scan wants a real recheck, typically right after
  // changing a threshold. Replaying yesterday's cached verdict would answer the
  // question they used to have.
  const scan = await scanAccount(client, config, blocklist, userId, { force: true });

  info({
    event: "verdict",
    chat_id: routed.chatId,
    user_id: userId,
    trigger: "scan_command",
    track: "B",
    flagged: scan.verdict === "flagged",
    verdict: scan.verdict,
    score: scan.finding?.score ?? null,
    class: scan.finding?.className ?? null,
    reason: scan.finding?.reason ?? null,
    matched_domain: scan.finding?.matchedDomain ?? null,
    cache: scan.cache,
    note: scan.note,
    ms: scan.ms,
    dry_run: config.dryRun,
  });

  if (scan.verdict === "unavailable") {
    return { outcome: "unavailable", removed: false, detail: scan.note ?? null };
  }
  if (scan.verdict !== "flagged" || !scan.finding) {
    return { outcome: "clean", removed: false, detail: null };
  }

  if (!shouldEnforce(scan.finding.reason, config)) {
    return { outcome: "flagged", removed: false, detail: `${scan.finding.reason} (not enforced)` };
  }

  const result = await enforce(client, config, {
    chatId: routed.chatId,
    userId,
    trigger: "scan_command",
    finding: scan.finding,
    messageId: null,
  });

  return { outcome: "flagged", removed: result.enforced, detail: scan.finding.reason };
}

function describeOne(context: Context, userId: number, result: OneResult): string {
  const dry = context.config.dryRun;
  switch (result.outcome) {
    case "exempt":
      return `${userId} is exempt from scanning (${result.detail}), so I left them alone.`;
    case "unavailable":
      return `I couldn't check ${userId} (${result.detail ?? "no signal"}).\n\n` +
        "That's not a pass — it usually means their profile photo is hidden by their " +
        "privacy settings, which I never treat as a violation.";
    case "gone":
      return `${userId} isn't in this group (${result.detail}), so I left them alone.`;
    case "clean":
      return `${userId} looks clean.`;
    case "flagged":
      if (dry) return `${userId} would have been removed (${result.detail}). DRY_RUN is on.`;
      if (result.removed) return `Removed ${userId} (${result.detail}) and revoked their messages.`;
      return `${userId} is flagged (${result.detail}) but I couldn't remove them — ` +
        "check my admin rights and the ban budget in the logs.";
  }
}

async function reply(context: Context, routed: Routed, text: string): Promise<void> {
  const sent = await context.client.sendMessage(routed.chatId, text, routed.messageId ?? undefined);
  if (!sent.ok) warn({ event: "command_reply_failed", chat_id: routed.chatId, error: sent.error });
}
