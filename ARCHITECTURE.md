# Architecture

The bot receives Telegram updates on one HTTP endpoint, logs every one of them,
and acts on exactly one class of them: an account joining a chat it polices.

The rule it enforces is "somebody has to have let you in". See the README for
what that means operationally; this document is about how the code is arranged
and why.

> An earlier version of this repo classified images for nudity and enforced on
> the result. That code and its design doc are in the git history at `02e9391`.

## Shape

```
Telegram  ──POST──▶  netlify/edge-functions/webhook.ts
                        │  1. method + content-type
                        │  2. secret header       (src/telegram/verify.ts)
                        │  3. JSON body           (src/telegram/types.ts)
                        │  4. classify            (src/classify.ts)
                        │  5. one log line each   (src/log.ts)
                        ▼
                     200 OK
                        │
                        └─ waitUntil ─▶  6. decide   (src/policy.ts)   pure
                                         7. enforce  (src/enforce.ts)  effects
```

| File                                | Role                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `netlify/edge-functions/webhook.ts` | The only entry point; the steps above, in order         |
| `src/config.ts`                     | Environment parsing, once per cold start                |
| `src/context.ts`                    | Config, API client and removal budget for one isolate   |
| `src/telegram/verify.ts`            | The secret-header comparison                            |
| `src/telegram/types.ts`             | The partial Bot API shapes that are actually read       |
| `src/telegram/api.ts`               | Every outbound call; four methods, no more              |
| `src/classify.ts`                   | update → `Event[]`, including how an account got in     |
| `src/policy.ts`                     | `Event` → `Decision`. Pure, and the whole rule          |
| `src/enforce.ts`                    | Decision → API calls → audit line                       |
| `src/log.ts`                        | Levelled one-JSON-object-per-line logging               |

## Decisions worth knowing

**Telegram is answered before any Bot API call.** It treats a slow response as a
delivery failure and redelivers, which on a cold start is a retry storm. The ban
and the unban run under `waitUntil`, which keeps the isolate alive past the
response — without it a torn-down isolate could ban an account and never reach
the unban that keeps it re-addable.

**The secret is checked before the body is read**, with a length-independent
comparison. An unauthenticated caller costs one header comparison and no JSON
parse.

**A bad configuration answers 200 and does nothing.** A non-2xx makes Telegram
retry forever and eventually puts the webhook into an error state, so failing
closed must not mean failing loudly at the HTTP layer. The operator's signal is
the `config_error` lines from startup. Config parsing never throws, for the same
reason.

**The policy is pure and the enforcement is not.** `decide()` takes an event, the
config and the bot's own id, and returns a `Decision` — no client, no clock, no
I/O. That is what makes every branch of the rule testable without stubbing the
Bot API, and the rule is the part that must not be wrong: the cost of a bug here
is throwing out someone a member invited.

**A `Decision` always carries a reason, and the reason is logged verbatim.** An
`allowed` line says *why* it was allowed. That is what makes a dry run readable,
and a dry run is how an operator is meant to gain confidence before turning
enforcement on.

**Enforcement only happens on `chat_member`.** It is the only update that
discloses the route in — the invite link, the approval flag, the adder. The
in-chat "X joined" service message says who added whom and nothing about links,
so a join seen only that way is classified `undisclosed` and, by default, left
alone. Reading that silence as "walked in unaided" would remove invited people.
`src/classify.ts` names the route; it never guesses one.

**Removal is a ban plus an immediate unban.** A plain ban would make "removed"
mean "blacklisted", which breaks the other half of the rule — that members can
add whoever they like, including someone the bot removed earlier. The unban uses
`only_if_banned` so it cannot itself become an invitation, and a failed unban is
its own log event rather than a silent one, because it leaves the account
unaddable.

**Nothing is ever deleted.** No `deleteMessage`, and `revoke_messages` is
explicitly `false` on the ban. Telegram can only mass-delete a member's history
as a side effect of banning, and that is irreversible for everyone in the chat;
it is not this bot's call to make.

**Two exemptions depend on the bot's own id.** It is never its own subject, and
an update the bot itself caused is never acted on — the loop guard. The deeper
guard is structural: only a *join* transition can produce an action, and a ban
produces `member -> kicked`, so the loop cannot close even when `getMe` has
failed and the id is unknown. Both are kept, because relying on the structural
one alone means one new branch in the policy can reopen the loop.

**An account that arrives already privileged is never touched.** Somebody with
the right to make an admin made them one, and that is a fight the bot cannot win.

**The removal budget lives on the `Context`, not in a module.** It is per
isolate either way, but as a value it is explicit in the type, injectable in
tests, and not order-dependent across them.

**Failures are values, not exceptions** (`ApiResult<T>`). A caller deciding
whether to act must be able to tell "checked and clean" from "could not check",
and a thrown error makes those two look the same at the catch site.

**Metadata only in the log.** The logger never receives message text, usernames
or the token — only ids, types, routes and reasons. That keeps the log useful for
answering "why was this person removed" without turning it into a copy of the
chat.
