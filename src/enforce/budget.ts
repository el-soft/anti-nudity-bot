// The per-chat enforcement budget: MAX_BANS_PER_HOUR.
//
// This is the circuit breaker for a misconfiguration or a bad threshold. It turns
// "the bot emptied my group overnight" into "the bot banned ten people and started
// shouting".

import type { Config } from "../config.ts";
import { errText, warn } from "../log.ts";
import { getStore } from "./store.ts";

interface Window {
  hour: number;
  count: number;
}

const key = (chatId: number) => `bans:${chatId}`;
const hourOf = (now: number) => Math.floor(now / 3_600_000);

export interface BudgetDecision {
  allowed: boolean;
  remaining: number;
}

/**
 * Reserve one enforcement against the current hour's budget.
 *
 * Read-modify-write without a lock, so two simultaneous bans in the same chat can
 * both read the same count and overshoot by one. Accepted deliberately: the
 * alternative is a distributed lock in the request path, and a cap that is
 * occasionally one high still bounds the damage it exists to bound.
 */
export async function reserve(
  chatId: number,
  config: Config,
  now = Date.now(),
): Promise<BudgetDecision> {
  const hour = hourOf(now);
  try {
    const store = await getStore();
    const raw = await store.get(key(chatId));
    const window: Window = raw ? JSON.parse(raw) as Window : { hour, count: 0 };
    if (window.hour !== hour) {
      window.hour = hour;
      window.count = 0;
    }
    if (window.count >= config.maxBansPerHour) {
      return { allowed: false, remaining: 0 };
    }
    window.count += 1;
    await store.set(key(chatId), JSON.stringify(window));
    return { allowed: true, remaining: config.maxBansPerHour - window.count };
  } catch (e) {
    // An unreadable counter must not silently disable the breaker, but it must
    // not block all enforcement either. Allow, and say so loudly.
    warn({ event: "budget_unavailable", chat_id: chatId, error: errText(e) });
    return { allowed: true, remaining: -1 };
  }
}
