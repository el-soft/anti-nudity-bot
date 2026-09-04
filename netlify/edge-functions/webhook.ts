import type { Config } from "@netlify/edge-functions";

// Minimal Telegram webhook: verify, filter by whitelist, log the IDs.
// Detection and enforcement are not implemented yet — see ARCHITECTURE.md.

interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  new_chat_members?: TelegramUser[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  chat_member?: {
    chat: { id: number };
    from: TelegramUser;
    new_chat_member: { user: TelegramUser };
  };
  my_chat_member?: { chat: { id: number }; from: TelegramUser };
  chat_join_request?: { chat: { id: number }; from: TelegramUser };
}

/** What we care about from any update shape, or null if we don't handle it. */
interface Subject {
  kind: string;
  chatId: number;
  userId: number | null;
  messageId: number | null;
}

const WEBHOOK_SECRET = Netlify.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";

const ALLOWED_CHAT_IDS = new Set(
  (Netlify.env.get("ALLOWED_CHAT_IDS") ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id !== 0),
);

/** Length-independent comparison, so the check leaks nothing by timing. */
function secretMatches(received: string | null): boolean {
  if (!WEBHOOK_SECRET || !received) return false;
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(WEBHOOK_SECRET);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function subjectOf(update: TelegramUpdate): Subject | null {
  const message = update.message ?? update.edited_message;
  if (message) {
    return {
      kind: message.new_chat_members?.length
        ? "join_notice"
        : update.edited_message
        ? "edited_message"
        : "message",
      chatId: message.chat.id,
      userId: message.from?.id ?? null,
      messageId: message.message_id,
    };
  }
  if (update.chat_member) {
    return {
      kind: "chat_member",
      chatId: update.chat_member.chat.id,
      userId: update.chat_member.new_chat_member.user.id,
      messageId: null,
    };
  }
  if (update.chat_join_request) {
    return {
      kind: "join_request",
      chatId: update.chat_join_request.chat.id,
      userId: update.chat_join_request.from.id,
      messageId: null,
    };
  }
  if (update.my_chat_member) {
    return {
      kind: "my_chat_member",
      chatId: update.my_chat_member.chat.id,
      userId: update.my_chat_member.from.id,
      messageId: null,
    };
  }
  return null;
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

export default async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token"))) {
    log({ level: "warn", event: "rejected", reason: "bad_secret" });
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    log({ level: "warn", event: "rejected", reason: "bad_json" });
    return new Response("Bad Request", { status: 400 });
  }

  const subject = subjectOf(update);

  // Everything below answers 200 so Telegram does not redeliver the update.
  if (!subject) {
    log({
      level: "debug",
      event: "skipped",
      reason: "unhandled_update",
      update_id: update.update_id,
    });
    return new Response("OK");
  }

  if (!ALLOWED_CHAT_IDS.has(subject.chatId)) {
    log({
      level: "info",
      event: "skipped",
      reason: "chat_not_whitelisted",
      update_id: update.update_id,
      kind: subject.kind,
      chat_id: subject.chatId,
    });
    return new Response("OK");
  }

  log({
    level: "info",
    event: "received",
    update_id: update.update_id,
    kind: subject.kind,
    chat_id: subject.chatId,
    user_id: subject.userId,
    message_id: subject.messageId,
  });

  // TODO: scan message media, scan the sender's profile, enforce.
  return new Response("OK");
};

export const config: Config = {
  path: "/telegram/webhook",
};
