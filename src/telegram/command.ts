// /scan parsing. Pure, so the targeting rules are unit-testable without a network.

import type { Message, User } from "./types.ts";

export type ScanTarget =
  | { kind: "user"; userId: number; source: "reply" | "mention" | "id" }
  | { kind: "sweep" }
  | { kind: "error"; detail: string };

export interface ParsedCommand {
  name: string;
  target: ScanTarget;
}

/** `/scan`, `/scan@thebot`, `/scan 12345`, `/scan` in reply to someone. */
const COMMAND = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/is;

/**
 * Returns null when the message is not a command for this bot — including a
 * command explicitly addressed to a *different* bot, which several bots in one
 * group makes common.
 */
export function parseCommand(message: Message, botUsername: string | null): ParsedCommand | null {
  const text = message.text?.trim();
  if (!text || !text.startsWith("/")) return null;

  const match = COMMAND.exec(text);
  if (!match) return null;

  const [, name, addressee, rest] = match;
  if (addressee && botUsername && addressee.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }

  return { name: name.toLowerCase(), target: resolveTarget(message, rest?.trim() ?? "") };
}

function resolveTarget(message: Message, argument: string): ScanTarget {
  // A reply is the most reliable form: Telegram hands over the full User, so
  // there is no name to resolve and no ambiguity about who is meant.
  const repliedTo: User | undefined = message.reply_to_message?.from;
  if (repliedTo) return { kind: "user", userId: repliedTo.id, source: "reply" };

  if (!argument) return { kind: "sweep" };

  // A tapped name arrives as a text_mention entity carrying the account itself.
  const mention = message.entities?.find((entity) => entity.type === "text_mention" && entity.user);
  if (mention?.user) return { kind: "user", userId: mention.user.id, source: "mention" };

  const numeric = Number(argument);
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    return { kind: "user", userId: numeric, source: "id" };
  }

  if (argument.startsWith("@")) {
    // Deliberately not supported. There is no Bot API method that turns a
    // @username into a user_id, and guessing is how the wrong person gets banned.
    return {
      kind: "error",
      detail: "I can't resolve a @username to an account — Telegram doesn't offer that to bots. " +
        "Reply to one of their messages with /scan instead, or pass their numeric user ID.",
    };
  }

  return { kind: "error", detail: `I don't understand "${argument}".` };
}
