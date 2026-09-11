# Architecture

The bot receives Telegram updates on one HTTP endpoint and writes one structured
log line per event. There is nothing else: no Bot API calls, no downloads, no
state, no storage.

> The previous version of this document described a two-track NSFW detection and
> enforcement design (profile scanning, media classification, link blocklists,
> ban budgets, a verdict cache on Netlify Blobs). That code has been removed.
> Both the code and the design doc are in the git history at `02e9391`.

## Shape

```
Telegram  ──POST──▶  netlify/edge-functions/webhook.ts
                        │  1. method + content-type
                        │  2. secret header      (src/telegram/verify.ts)
                        │  3. JSON body          (src/telegram/types.ts)
                        │  4. classify           (src/classify.ts)
                        │  5. one log line each  (src/log.ts)
                        ▼
                     200 OK
```

| File                               | Role                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `netlify/edge-functions/webhook.ts`| The only entry point; the steps above, in order       |
| `src/config.ts`                    | Environment parsing, once per cold start              |
| `src/telegram/verify.ts`           | The secret-header comparison                          |
| `src/telegram/types.ts`            | The partial Bot API shapes that are actually read     |
| `src/classify.ts`                  | update → `Event[]`; pure, and the only real logic      |
| `src/log.ts`                       | Levelled one-JSON-object-per-line logging             |

## Decisions worth knowing

**The secret is checked before the body is read.** An unauthenticated caller
costs one header comparison and no JSON parse. The comparison is
length-independent so it leaks nothing about the secret by timing.

**A bad configuration answers 200 and processes nothing.** A non-2xx makes
Telegram retry the same update forever and eventually puts the webhook into an
error state, so failing closed must not mean failing loudly at the HTTP layer.
The operator's signal is the `config_error` lines from startup. Configuration
parsing never throws, for the same reason.

**The response is not deferred.** Classification is synchronous and allocation-
cheap, so there is no work to keep alive after the response — no `waitUntil`, and
no risk of an isolate being torn down mid-task.

**Classification is pure and returns a list.** One update can describe several
events: a join notice naming three accounts is three `joined` events. Keeping it
pure is what makes the mapping testable without a Bot API stub, and the mapping
is the whole product.

**A membership update is named by its transition.** Telegram sends the same
`chat_member` shape for a join, a departure, a ban, a promotion and a mute; only
`old_chat_member.status -> new_chat_member.status` distinguishes them. Both that
status pair and the admin who caused it go into `detail`.

**An unrecognised update is logged as `unknown`, never dropped.** Telegram adds
update types faster than this repo tracks them, and a line saying "something
arrived that we cannot name" is the signal that `src/classify.ts` needs a new
branch.

**Metadata only.** The logger never receives message text, usernames, bios or
file bytes — only ids, types and the small `detail` string. That keeps the log
useful for traffic questions without turning it into a copy of the chat.
