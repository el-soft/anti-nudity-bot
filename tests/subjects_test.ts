import { assert, assertEquals } from "@std/assert";
import { route } from "../src/telegram/subjects.ts";
import type { Update } from "../src/telegram/types.ts";

const SELF = 42;
const load = (name: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(`../fixtures/${name}.json`, import.meta.url))) as Update;

Deno.test("an ordinary photo message resolves to its sender", () => {
  const routed = route(load("message_photo"), SELF);
  assertEquals(routed.kind, "message");
  assertEquals(routed.trigger, "message");
  assertEquals(routed.chatId, -1001234567890);
  assertEquals(routed.subjects.length, 1);
  assertEquals(routed.subjects[0].userId, 55512345);
  assert(routed.subjects[0].actionable);
});

Deno.test("a chat_member join resolves to the joining user", () => {
  const routed = route(load("join_chat_member"), SELF);
  assertEquals(routed.kind, "join");
  assertEquals(routed.subjects[0].userId, 777888999);
  assertEquals(routed.joinedAt, 1757000100);
});

Deno.test("a join request is not actionable — it is declined, never banned", () => {
  const routed = route(load("join_request"), SELF);
  assertEquals(routed.kind, "join_request");
  assertEquals(routed.subjects[0].actionable, false);
});

Deno.test("a forward yields both the forwarder and the origin author", () => {
  const routed = route(load("message_forward"), SELF);
  assertEquals(routed.subjects.length, 2);
  const sender = routed.subjects.find((s) => s.role === "sender")!;
  const origin = routed.subjects.find((s) => s.role === "forward_origin")!;
  assertEquals(sender.userId, 55512345);
  assert(sender.actionable);
  assertEquals(origin.userId, 999000111);
  // The original author is not a member of this chat, so a ban here is meaningless.
  assertEquals(origin.actionable, false);
});

Deno.test("only an absent -> present transition counts as a join", () => {
  const base = load("join_chat_member");
  for (
    const [was, now] of [["member", "administrator"], ["member", "left"], ["restricted", "member"]]
  ) {
    const update = structuredClone(base);
    update.chat_member!.old_chat_member.status = was as never;
    update.chat_member!.new_chat_member.status = now as never;
    const routed = route(update, SELF);
    assertEquals(routed.kind, "drop", `${was} -> ${now} should not be a join`);
  }
});

Deno.test("new_chat_members scans every added account and drops the bot itself", () => {
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1757000000,
      chat: { id: -100, type: "supergroup" },
      from: { id: 5, is_bot: false },
      new_chat_members: [
        { id: 111, is_bot: false },
        { id: 222, is_bot: true },
        { id: SELF, is_bot: true },
      ],
    },
  };
  const routed = route(update, SELF);
  assertEquals(routed.kind, "join");
  assertEquals(routed.subjects.map((s) => s.userId), [111, 222]);
  assertEquals(routed.messageId, 10);
});

Deno.test("anonymous admin posts and channel auto-forwards have no subject", () => {
  const anonymous: Update = {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      sender_chat: { id: -100, type: "supergroup" },
    },
  };
  assertEquals(route(anonymous, SELF).kind, "drop");

  const autoForward: Update = {
    update_id: 3,
    message: {
      message_id: 12,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 7, is_bot: true },
      is_automatic_forward: true,
    },
  };
  assertEquals(route(autoForward, SELF).kind, "drop");
});

Deno.test("uninteresting service messages are dropped", () => {
  const update: Update = {
    update_id: 4,
    message: {
      message_id: 13,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 7 },
      left_chat_member: { id: 8 },
    },
  };
  assertEquals(route(update, SELF).reason, "service_message");
});

Deno.test("an edited message keeps its own trigger name", () => {
  const original = load("message_photo");
  const edited: Update = { update_id: 5, edited_message: original.message };
  assertEquals(route(edited, SELF).trigger, "edited_message");
});
