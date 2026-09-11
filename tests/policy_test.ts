import { assertEquals } from "@std/assert";
import { classify } from "../src/classify.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { decide } from "../src/policy.ts";
import type { ChatInviteLink, Update } from "../src/telegram/types.ts";

const CHAT = { id: -1001234567890, type: "supergroup" as const, title: "Test Group" };
const BOT = 999;
const JOINER = 100;
const MEMBER = 42;

function config(overrides: Record<string, string> = {}): Config {
  const merged: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(64),
    ALLOWED_CHAT_IDS: String(CHAT.id),
    ...overrides,
  };
  const { config, fatal } = parseConfig((key) => merged[key]);
  assertEquals(fatal, []);
  return config;
}

/** The single event a join update produces, run through the policy. */
function verdict(update: Update, cfg: Config = config()) {
  const events = classify(update);
  assertEquals(events.length, 1);
  return decide(events[0], cfg, BOT);
}

interface JoinOptions {
  actorId?: number;
  userId?: number;
  to?: string;
  inviteLink?: ChatInviteLink;
  viaJoinRequest?: boolean;
  viaChatFolder?: boolean;
}

function join(options: JoinOptions = {}): Update {
  const userId = options.userId ?? JOINER;
  return {
    update_id: 1,
    chat_member: {
      chat: CHAT,
      from: { id: options.actorId ?? userId },
      date: 0,
      old_chat_member: { status: "left", user: { id: userId } },
      new_chat_member: {
        status: (options.to ?? "member") as "member",
        user: { id: userId },
      },
      invite_link: options.inviteLink,
      via_join_request: options.viaJoinRequest,
      via_chat_folder_invite_link: options.viaChatFolder,
    },
  };
}

const LINK: ChatInviteLink = { invite_link: "https://t.me/+abc", creator: { id: MEMBER } };

Deno.test("an account that walks in unaided is removed", () => {
  const decision = verdict(join());
  assertEquals(decision.action, "remove");
  assertEquals(decision.reason, "joined_unaided");
  assertEquals(decision.userId, JOINER);
  assertEquals(decision.chatId, CHAT.id);
});

Deno.test("an account added by a member stays", () => {
  const decision = verdict(join({ actorId: MEMBER }));
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "added_by_member");
});

Deno.test("an account that follows an invite link itself is removed", () => {
  const decision = verdict(join({ inviteLink: LINK }));
  assertEquals(decision.action, "remove");
  assertEquals(decision.reason, "joined_by_self:invite_link");
});

Deno.test("an account that follows a chat-folder link itself is removed", () => {
  const decision = verdict(join({ viaChatFolder: true }));
  assertEquals(decision.action, "remove");
  assertEquals(decision.reason, "joined_by_self:chat_folder");
});

Deno.test("a link join somebody else carried out stays: they were let in", () => {
  const decision = verdict(join({ actorId: MEMBER, inviteLink: LINK }));
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "invite_link_allowed");
});

Deno.test("with self-joins allowed, the invite-link setting decides again", () => {
  const lenient = config({ REMOVE_SELF_JOINS: "false" });
  assertEquals(verdict(join({ inviteLink: LINK }), lenient).reason, "invite_link_allowed");
  assertEquals(
    verdict(join({ viaChatFolder: true }), lenient).reason,
    "chat_folder_link_allowed",
  );

  const strict = config({ REMOVE_SELF_JOINS: "false", ALLOW_INVITE_LINK_JOINS: "false" });
  assertEquals(verdict(join({ inviteLink: LINK }), strict).reason, "joined_by_invite_link");
  assertEquals(
    verdict(join({ viaChatFolder: true }), strict).reason,
    "joined_by_chat_folder_link",
  );
});

Deno.test("an approved join request stays, whoever the actor is", () => {
  const decision = verdict(join({ actorId: MEMBER, viaJoinRequest: true, inviteLink: LINK }));
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "approved_by_admin");
});

Deno.test("the bot is never its own subject", () => {
  const decision = verdict(join({ userId: BOT }));
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "self");
});

Deno.test("an update the bot itself caused is never acted on again", () => {
  // The loop guard: removing someone produces a membership update of its own.
  const decision = verdict(join({ actorId: BOT }));
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "own_action");
});

Deno.test("an exempt account is never removed", () => {
  const cfg = config({ EXEMPT_USER_IDS: `${JOINER},555` });
  const decision = verdict(join(), cfg);
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "exempt_user");
});

Deno.test("an account that arrives as an admin is left alone", () => {
  for (const to of ["administrator", "creator"]) {
    const decision = verdict(join({ to }));
    assertEquals(decision.action, "none");
    assertEquals(decision.reason, "privileged");
  }
});

Deno.test("a chat outside the whitelist is never policed", () => {
  const cfg = config({ ALLOWED_CHAT_IDS: "-100777" });
  const decision = verdict(join(), cfg);
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "chat_not_whitelisted");
});

Deno.test("a service-message join is not acted on: its route is not disclosed", () => {
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      from: { id: JOINER },
      new_chat_members: [{ id: JOINER }],
    },
  };
  assertEquals(verdict(update).reason, "route_undisclosed");

  const cfg = config({ REMOVE_UNDISCLOSED_JOINS: "true" });
  const decision = verdict(update, cfg);
  assertEquals(decision.action, "remove");
  assertEquals(decision.reason, "joined_by_undisclosed_route");
});

Deno.test("a service-message join performed by a member is allowed outright", () => {
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      from: { id: MEMBER },
      new_chat_members: [{ id: JOINER }],
    },
  };
  // Still allowed with the strict setting on: somebody vouched for them.
  const cfg = config({ REMOVE_UNDISCLOSED_JOINS: "true" });
  assertEquals(verdict(update, cfg).reason, "added_by_member");
});

Deno.test("leaving, being removed and being promoted are not the policy's business", () => {
  const transition = (from: string, to: string, actorId = MEMBER) =>
    verdict({
      update_id: 1,
      chat_member: {
        chat: CHAT,
        from: { id: actorId },
        date: 0,
        old_chat_member: { status: from as "member", user: { id: JOINER } },
        new_chat_member: { status: to as "member", user: { id: JOINER } },
      },
    });

  assertEquals(transition("member", "left").action, "none");
  assertEquals(transition("member", "left").reason, "not_a_join:left");
  assertEquals(transition("member", "kicked").reason, "not_a_join:kicked");
  assertEquals(transition("member", "administrator").reason, "not_a_join:administrator");
  assertEquals(transition("member", "restricted").reason, "not_a_join:restricted");
});

Deno.test("a join request is left to the admins by default", () => {
  const update: Update = {
    update_id: 1,
    chat_join_request: { chat: CHAT, from: { id: JOINER }, user_chat_id: JOINER, date: 0 },
  };
  assertEquals(verdict(update).action, "none");
  assertEquals(verdict(update).reason, "join_requests_left_to_admins");

  const cfg = config({ JOIN_REQUEST_ACTION: "decline" });
  const decision = verdict(update, cfg);
  assertEquals(decision.action, "decline_join_request");
  assertEquals(decision.userId, JOINER);
});

Deno.test("an exempt account's join request is never declined", () => {
  const cfg = config({ JOIN_REQUEST_ACTION: "decline", EXEMPT_USER_IDS: String(JOINER) });
  const update: Update = {
    update_id: 1,
    chat_join_request: { chat: CHAT, from: { id: JOINER }, user_chat_id: JOINER, date: 0 },
  };
  assertEquals(verdict(update, cfg).action, "none");
});

Deno.test("an ordinary message produces no action", () => {
  const decision = verdict({
    update_id: 1,
    message: { message_id: 7, date: 0, chat: CHAT, from: { id: MEMBER }, text: "hello" },
  });
  assertEquals(decision.action, "none");
  assertEquals(decision.reason, "not_a_membership_change");
});

Deno.test("with the bot's own id unknown, a self-join is still removed", () => {
  // getMe can fail; the policy must not fall open when it does.
  const events = classify(join());
  assertEquals(decide(events[0], config(), null).action, "remove");
});
