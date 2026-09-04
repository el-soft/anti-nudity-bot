import { assert, assertEquals } from "@std/assert";
import { parseCommand } from "../src/telegram/command.ts";
import type { Message } from "../src/telegram/types.ts";

const message = (fields: Partial<Message>): Message => ({
  message_id: 1,
  date: 1,
  chat: { id: -100, type: "supergroup" },
  from: { id: 5, is_bot: false },
  ...fields,
});

Deno.test("a bare /scan is a sweep", () => {
  const parsed = parseCommand(message({ text: "/scan" }), "mybot");
  assertEquals(parsed?.name, "scan");
  assertEquals(parsed?.target.kind, "sweep");
});

Deno.test("a command addressed to another bot is not ours", () => {
  assertEquals(parseCommand(message({ text: "/scan@otherbot" }), "mybot"), null);
  assertEquals(parseCommand(message({ text: "/scan@MyBot" }), "mybot")?.name, "scan");
});

Deno.test("a reply targets the account replied to", () => {
  const parsed = parseCommand(
    message({
      text: "/scan",
      reply_to_message: message({ message_id: 2, from: { id: 999, is_bot: false } }),
    }),
    "mybot",
  );
  assert(parsed);
  assertEquals(parsed.target, { kind: "user", userId: 999, source: "reply" });
});

Deno.test("a numeric argument targets that user", () => {
  const parsed = parseCommand(message({ text: "/scan 123456" }), "mybot");
  assertEquals(parsed?.target, { kind: "user", userId: 123456, source: "id" });
});

Deno.test("a tapped name resolves through the text_mention entity", () => {
  const parsed = parseCommand(
    message({
      text: "/scan Someone",
      entities: [{ type: "text_mention", offset: 6, length: 7, user: { id: 4242 } }],
    }),
    "mybot",
  );
  assertEquals(parsed?.target, { kind: "user", userId: 4242, source: "mention" });
});

Deno.test("a @username is refused rather than guessed at", () => {
  const parsed = parseCommand(message({ text: "/scan @someone" }), "mybot");
  assert(parsed);
  // There is no Bot API method that turns a @username into a user_id, and
  // guessing is how the wrong person gets banned.
  assertEquals(parsed.target.kind, "error");
});

Deno.test("ordinary text is not a command", () => {
  assertEquals(parseCommand(message({ text: "scan this please" }), "mybot"), null);
  assertEquals(parseCommand(message({ text: "" }), "mybot"), null);
  assertEquals(parseCommand(message({}), "mybot"), null);
});

Deno.test("a photo captioned /scan is not a command", () => {
  // Captions arrive in `caption`, not `text`, so this stays on the normal path
  // and the image still gets scanned.
  assertEquals(parseCommand(message({ photo: [] }), "mybot"), null);
});

Deno.test("other commands parse but are not /scan", () => {
  assertEquals(parseCommand(message({ text: "/start" }), "mybot")?.name, "start");
});
