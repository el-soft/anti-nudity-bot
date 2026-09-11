import { assertEquals } from "@std/assert";
import { classify } from "../src/classify.ts";
import type { Update } from "../src/telegram/types.ts";

const CHAT = { id: -1001234567890, type: "supergroup" as const, title: "Test Group" };

function one(update: Update) {
  const events = classify(update);
  assertEquals(events.length, 1);
  return events[0];
}

async function fixture(name: string): Promise<Update> {
  return JSON.parse(await Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url)));
}

Deno.test("a text message reports the chat, the sender and the content kind", () => {
  const event = one({
    update_id: 1,
    message: { message_id: 7, date: 0, chat: CHAT, from: { id: 42 }, text: "hello" },
  });
  assertEquals(event.messageType, "message.text");
  assertEquals(event.chatId, CHAT.id);
  assertEquals(event.userId, 42);
  assertEquals(event.messageId, 7);
  assertEquals(event.chatType, "supergroup");
});

Deno.test("an edit is distinguishable from the original post", () => {
  const event = one({
    update_id: 1,
    edited_message: { message_id: 7, date: 0, chat: CHAT, from: { id: 42 }, text: "hi" },
  });
  assertEquals(event.messageType, "edited_message.text");
});

Deno.test("media is named by its kind", () => {
  const photo = one({
    update_id: 1,
    message: { message_id: 7, date: 0, chat: CHAT, from: { id: 42 }, photo: [{}] },
  });
  assertEquals(photo.messageType, "message.photo");

  const sticker = one({
    update_id: 1,
    message: { message_id: 8, date: 0, chat: CHAT, from: { id: 42 }, sticker: {} },
  });
  assertEquals(sticker.messageType, "message.sticker");
});

Deno.test("a message with no recognised content is still logged", () => {
  const event = one({
    update_id: 1,
    message: { message_id: 7, date: 0, chat: CHAT, from: { id: 42 } },
  });
  assertEquals(event.messageType, "message.other");
});

Deno.test("a channel post has no user behind it", () => {
  const event = one({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      sender_chat: { id: -100999, type: "channel" },
      text: "announcement",
    },
  });
  assertEquals(event.userId, null);
  assertEquals(event.detail, "sender_chat=-100999");
});

Deno.test("a forward and a reply are noted without touching the text", () => {
  const event = one({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      from: { id: 42 },
      text: "fwd",
      forward_origin: { type: "hidden_user" },
      reply_to_message: { message_id: 6, date: 0, chat: CHAT },
    },
  });
  assertEquals(event.detail, "forward=hidden_user,reply");
});

Deno.test("one join notice naming several accounts is one event per account", () => {
  const events = classify({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      from: { id: 42 },
      new_chat_members: [{ id: 100 }, { id: 200, is_bot: true }],
    },
  });
  assertEquals(events.map((e) => e.messageType), ["joined", "joined"]);
  assertEquals(events.map((e) => e.userId), [100, 200]);
  assertEquals(events[0].isBot, undefined);
  assertEquals(events[1].isBot, true);
});

Deno.test("a departure names the account that left, not the admin", () => {
  const event = one({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      from: { id: 42 },
      left_chat_member: { id: 100 },
    },
  });
  assertEquals(event.messageType, "left");
  assertEquals(event.userId, 100);
});

Deno.test("service messages are named instead of being called messages", () => {
  const pinned = one({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: CHAT,
      from: { id: 42 },
      pinned_message: { message_id: 6, date: 0, chat: CHAT },
    },
  });
  assertEquals(pinned.messageType, "message_pinned");

  const renamed = one({
    update_id: 1,
    message: { message_id: 8, date: 0, chat: CHAT, from: { id: 42 }, new_chat_title: "New" },
  });
  assertEquals(renamed.messageType, "chat_title_changed");
});

Deno.test("a membership update is named by the transition it made", () => {
  const member = (status: string) => ({ status: status as "member", user: { id: 100 } });
  const event = (from: string, to: string) =>
    one({
      update_id: 1,
      chat_member: {
        chat: CHAT,
        from: { id: 42 },
        date: 0,
        old_chat_member: member(from),
        new_chat_member: member(to),
      },
    });

  assertEquals(event("left", "member").messageType, "joined");
  assertEquals(event("member", "left").messageType, "left");
  assertEquals(event("member", "kicked").messageType, "banned");
  assertEquals(event("member", "administrator").messageType, "role_changed");
  assertEquals(event("member", "member").messageType, "membership_changed");
});

Deno.test("the membership transition and the acting admin are kept in detail", () => {
  const event = one({
    update_id: 1,
    my_chat_member: {
      chat: CHAT,
      from: { id: 42 },
      date: 0,
      old_chat_member: { status: "left", user: { id: 999 } },
      new_chat_member: { status: "administrator", user: { id: 999 } },
    },
  });
  assertEquals(event.messageType, "joined");
  assertEquals(event.userId, 999);
  assertEquals(event.detail, "via=my_chat_member,left->administrator,by=42");
});

Deno.test("a reaction reports the reacting account and the message reacted to", () => {
  const event = one({
    update_id: 1,
    message_reaction: { chat: CHAT, message_id: 7, user: { id: 42 }, date: 0 },
  });
  assertEquals(event.messageType, "reaction");
  assertEquals(event.userId, 42);
  assertEquals(event.messageId, 7);
});

Deno.test("an anonymous reaction has no user, and says so", () => {
  const event = one({
    update_id: 1,
    message_reaction: { chat: CHAT, message_id: 7, actor_chat: { id: -100999 }, date: 0 },
  });
  assertEquals(event.userId, null);
  assertEquals(event.detail, "actor=chat");
});

Deno.test("a join request is reported before the account is in the chat", () => {
  const event = one({
    update_id: 1,
    chat_join_request: { chat: CHAT, from: { id: 42 }, user_chat_id: 42, date: 0 },
  });
  assertEquals(event.messageType, "join_request");
  assertEquals(event.userId, 42);
});

Deno.test("updates that carry no chat still report the account", () => {
  const inline = one({ update_id: 1, inline_query: { id: "q", from: { id: 42 } } });
  assertEquals(inline.messageType, "inline_query");
  assertEquals(inline.chatId, null);
  assertEquals(inline.userId, 42);

  const answer = one({ update_id: 1, poll_answer: { poll_id: "p", user: { id: 42 } } });
  assertEquals(answer.messageType, "poll_answer");
  assertEquals(answer.userId, 42);
});

Deno.test("a callback query borrows the chat from the message it came from", () => {
  const event = one({
    update_id: 1,
    callback_query: { id: "c", from: { id: 42 }, message: { chat: CHAT, message_id: 7 } },
  });
  assertEquals(event.messageType, "callback_query");
  assertEquals(event.chatId, CHAT.id);
  assertEquals(event.messageId, 7);
});

Deno.test("an update type this bot has never seen is logged, not dropped", () => {
  const event = one({ update_id: 1 } as Update);
  assertEquals(event.messageType, "unknown");
});

Deno.test("the recorded fixtures classify as expected", async () => {
  assertEquals(one(await fixture("message_photo.json")).messageType, "message.photo");
  assertEquals(one(await fixture("join_chat_member.json")).messageType, "joined");
  assertEquals(one(await fixture("join_request.json")).messageType, "join_request");

  const forward = one(await fixture("message_forward.json"));
  assertEquals(forward.messageType.startsWith("message."), true);
});
