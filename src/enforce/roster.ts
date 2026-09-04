// The set of accounts this deployment has actually seen in a chat.
//
// This exists because of a hard Bot API limitation: **there is no method that
// enumerates a group's members.** `getChatMember` needs a user_id you already
// have, and `getChatAdministrators` returns only admins. So "scan everyone in
// this group" is not something a bot can do — the closest honest approximation is
// "scan everyone this bot has observed", which is what the roster records and what
// `/scan` sweeps.
//
// One key per member rather than one growing list per chat: a list would be a
// read-modify-write race on every message, and members would silently go missing.

import { debug, errText, warn } from "../log.ts";
import { getStore } from "./store.ts";

const prefix = (chatId: number) => `member:${chatId}:`;
const key = (chatId: number, userId: number) => `${prefix(chatId)}${userId}`;

export interface RosterEntry {
  userId: number;
  /** Unix seconds. Refreshed on every sighting, so it doubles as "last seen". */
  seenAt: number;
}

/** Records a sighting. Cheap and best-effort: a lost write costs one member from
 * a future sweep, never a wrong verdict. */
export async function recordMember(chatId: number, userId: number): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key(chatId, userId), JSON.stringify({ seenAt: Math.floor(Date.now() / 1000) }));
  } catch (e) {
    debug({ event: "roster_write_failed", chat_id: chatId, user_id: userId, error: errText(e) });
  }
}

/** Drops an account from the roster — it has left, or was never really here. A
 * sweep that keeps trying to ban people who are gone is worse than useless. */
export async function forgetMember(chatId: number, userId: number): Promise<void> {
  try {
    const store = await getStore();
    await store.delete(key(chatId, userId));
  } catch (e) {
    debug({ event: "roster_delete_failed", chat_id: chatId, user_id: userId, error: errText(e) });
  }
}

/** Every account observed in this chat, most recently seen first. */
export async function listMembers(chatId: number): Promise<RosterEntry[]> {
  try {
    const store = await getStore();
    const keys = await store.list(prefix(chatId));
    const entries: RosterEntry[] = [];
    for (const found of keys) {
      const userId = Number(found.slice(prefix(chatId).length));
      if (!Number.isSafeInteger(userId) || userId === 0) continue;
      const raw = await store.get(found);
      let seenAt = 0;
      try {
        seenAt = raw ? (JSON.parse(raw) as { seenAt?: number }).seenAt ?? 0 : 0;
      } catch { /* a corrupt entry still names a real member */ }
      entries.push({ userId, seenAt });
    }
    entries.sort((a, b) => b.seenAt - a.seenAt);
    return entries;
  } catch (e) {
    warn({ event: "roster_read_failed", chat_id: chatId, error: errText(e) });
    return [];
  }
}
