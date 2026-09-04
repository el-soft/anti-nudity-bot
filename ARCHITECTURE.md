# Architecture

How `nudity-detector-bot` is put together, why it is shaped this way, and where the
sharp edges are. Read [README.md](./README.md) first if you only want to deploy it.

---

## Contents

- [Goals and non-goals](#goals-and-non-goals)
- [What the bot watches](#what-the-bot-watches)
- [Two enforcement tracks](#two-enforcement-tracks)
- [Deployment target](#deployment-target)
- [Update routing](#update-routing)
- [Trigger 1 — a user joins](#trigger-1--a-user-joins)
- [Trigger 2 — a user posts](#trigger-2--a-user-posts)
- [Request flow](#request-flow)
- [Trust boundary and the whitelist](#trust-boundary-and-the-whitelist)
- [Identifying who to scan](#identifying-who-to-scan)
- [Account scan: profile photo](#account-scan-profile-photo)
- [Account scan: bio and links](#account-scan-bio-and-links)
- [Enforcement: delete and ban](#enforcement-delete-and-ban)
- [The verdict cache](#the-verdict-cache)
- [Model hosting and cold start](#model-hosting-and-cold-start)
- [Image decoding in the Edge sandbox](#image-decoding-in-the-edge-sandbox)
- [Classification and thresholds](#classification-and-thresholds)
- [Media extraction rules](#media-extraction-rules)
- [Safeguards against wrongful bans](#safeguards-against-wrongful-bans)
- [Idempotency and retries](#idempotency-and-retries)
- [Failure modes and how each is handled](#failure-modes-and-how-each-is-handled)
- [Observability and the audit trail](#observability-and-the-audit-trail)
- [Planned file layout](#planned-file-layout)
- [Configuration surface](#configuration-surface)
- [Fallback: the split deployment](#fallback-the-split-deployment)
- [Open questions](#open-questions)

---

## Goals and non-goals

**Goals**

- Keep explicit-content and scam accounts out of a small set of explicitly whitelisted
  Telegram groups, by checking **who is posting** as well as **what they posted**.
- Catch a bad account at the **earliest possible moment** — at join time, before it
  ever posts.
- Classify images **locally**, inside the operator's own deployment. No third-party
  moderation API for nudity detection.
- Be deployable by a non-author: fork, connect to Netlify, set a few variables,
  register a webhook, promote the bot to admin.
- Fail *visibly* and *conservatively*. A broken classifier must show up in the logs,
  never as a silent pass — and never as a ban.

**Non-goals**

- Not a general anti-spam system. No message-rate heuristics, no CAS/Combot-style
  shared blocklist, no captcha gate.
- Not a video moderator. Videos and GIFs are judged by their thumbnail only.
- Not multi-tenant. One deployment serves one operator's chats. Configuration is
  environment variables; there is no per-chat override and no admin UI.
- Not an appeals system. A ban is reversible only by a human. The bot writes an audit
  line so that human can find it — see [Safeguards](#safeguards-against-wrongful-bans).
- Not an accuracy claim. nsfwjs is a MobileNet-class heuristic and the link check is a
  blocklist. Both make mistakes; the operator picks the thresholds.

---

## What the bot watches

The bot subscribes to **messages and membership notifications** from whitelisted
chats — not just messages. Five update types matter:

| Update | Why it is needed |
|---|---|
| `message` | The per-post scan (Track A + Track B), and the `new_chat_members` service message |
| `edited_message` | An image or caption swapped in by an edit still gets scanned |
| `chat_member` | **The reliable join signal.** `ChatMemberUpdated` fires on every membership transition |
| `chat_join_request` | Lets the bot vet an account *before* admitting it, in groups with approval enabled |
| `my_chat_member` | The bot's own status: added to a chat, promoted, demoted, removed |

Two of these need explicit opt-in, which is the single most common reason a
join-scanning bot silently does nothing:

- **`chat_member` is not delivered by default.** It must be listed in
  `allowed_updates` on `setWebhook`, *and* the bot must be an administrator of the
  chat. Miss either and no join updates arrive at all.
- **`chat_join_request`** likewise must be in `allowed_updates`, and requires the
  `can_invite_users` admin right to act on.

`my_chat_member` is watched for two housekeeping jobs: verifying the bot's own admin
rights the moment it is promoted (rather than discovering they are missing at the
moment of a ban), and optionally leaving any chat that is not in `ALLOWED_CHAT_IDS` —
since the bot's username is public, anyone can add it to their own group.

Everything else — `left_chat_member`, title and photo changes, pinned messages,
polls, reactions — is acknowledged and dropped.

---

## Two enforcement tracks

The bot makes two different kinds of judgement. Keeping them separate is the central
design decision, because they have very different false-positive costs.

| | **Track A — message content** | **Track B — the account** |
|---|---|---|
| What is examined | The image attached to a message | The sender's profile photo and bio |
| Question asked | "Is this picture explicit?" | "Is this account an explicit-content or scam account?" |
| When it runs | On every message with scannable media | On join, on join request, and on a post by an unscanned account |
| Action | Reply with a warning; leave the message | **Delete the message, revoke the account's history, ban the account** |
| Threshold | `NSFW_THRESHOLD` (default `0.7`) | `PROFILE_NSFW_THRESHOLD` (default `0.9`) |
| Cost of a false positive | An embarrassing bot reply under an innocent photo | A real member is removed and their history erased |
| Reversible by | Ignoring it | A human, manually |

The tracks are independent. A member can post a flagged photo and get only a warning,
while another account is banned for its avatar without having posted anything at all.

**Track A's action is deliberately not a ban.** An explicit image in a message earns a
warning; an explicit *profile* earns a ban. The reasoning is that a single image can be
a mistake, a forward, or a joke, whereas an explicit avatar is what the account *is* —
a standing advertisement that persists in every message it ever sends. If you want
message content to also remove the account, `MESSAGE_ACTION=warn_and_delete` deletes
the message, and `ENFORCEMENT_REASONS` can be extended to `message_nsfw` — but that is
an opt-in, not the default, and the README says why.

---

## Deployment target

**Netlify Edge Functions**, which run on **Deno** on Netlify's edge network.

The Edge runtime is a Deno sandbox with meaningful restrictions, and they drive most
of the design decisions below:

| Constraint | Consequence for this project |
|---|---|
| No filesystem writes | The model cannot be cached to disk; it lives in the bundle or in module-scope memory. The verdict cache must be **Netlify Blobs**, not a temp file. |
| No native addons | `@tensorflow/tfjs-node` is unavailable. The classifier runs on the **WASM** (or pure-JS) TFJS backend. |
| No `canvas`, no Node image libs | Decoding must be pure JavaScript. |
| Bundle size ceiling | Model weights + WASM binaries dominate the bundle; they may have to be fetched at runtime. |
| Isolates are recycled freely | Module-scope caching is best-effort. Assume a cold start on any request. |
| Response deadline | Telegram must be answered fast, so scanning and enforcement are decoupled from the response. |

Netlify's exact numeric limits change; treat the table as directional and check
Netlify's Edge Functions documentation for current figures before tuning.

Routing is declared in `netlify.toml`:

```toml
[[edge_functions]]
  path     = "/telegram/webhook"
  function = "webhook"
```

so the public endpoint is `https://<site>.netlify.app/telegram/webhook`.

**Required bot privileges.** The bot must be an administrator in every whitelisted
group, with:

| Right | Needed for |
|---|---|
| `can_delete_messages` | Deleting flagged messages and join notices |
| `can_restrict_members` | `banChatMember` — the ban and the history wipe |
| *administrator at all* | Receiving `chat_member` updates. Without admin status there is **no join signal**. |
| `can_invite_users` | Approving/declining `chat_join_request` (only if that trigger is enabled) |

Missing rights are logged loudly at startup and on `my_chat_member` promotion, rather
than discovered at the moment enforcement is attempted.

---

## Update routing

One entry point demultiplexes every update to a handler:

```
update
 ├── my_chat_member                       -> verify own rights / leave unlisted chat
 ├── chat_join_request                    -> Trigger 1b: vet before admitting
 ├── chat_member
 │     old.status ∈ {left, kicked}
 │     new.status ∈ {member, restricted}  -> Trigger 1a: a user joined
 │     (anything else)                    -> drop
 ├── message / edited_message
 │     ├── new_chat_members[]             -> Trigger 1a (fallback path)
 │     ├── other service message          -> drop
 │     └── ordinary message               -> Trigger 2: Track A + Track B
 └── anything else                        -> drop
```

Join detection has two paths on purpose. `chat_member` is authoritative and fires for
every transition including invite-link joins, but only reaches an admin bot that asked
for it. The `new_chat_members` service message is the fallback: it arrives on the
ordinary `message` stream, needs no special opt-in, but is not emitted in every
configuration.

Both paths can fire for the same join. The [verdict cache](#the-verdict-cache) makes
the duplicate free — the second one hits a cached verdict and does nothing.

---

## Trigger 1 — a user joins

The earliest and cheapest place to catch a bad account: it has posted nothing, so
there is no history to wipe and nothing for members to have seen.

**1a. On join** (`chat_member` transition, or `new_chat_members`)

```
1. resolve the joining user_id (each entry in new_chat_members, or
   chat_member.new_chat_member.user)
2. skip if: the bot itself, a bot account (unless SCAN_BOTS), exempt, or
   already cached
3. run the account scan  -> profile photo + bio
4. violation?
     no  -> cache "clean", done
     yes -> ENFORCE:
            · banChatMember(revoke_messages = true)
            · deleteMessage(the "X joined the group" notice), if
              DELETE_JOIN_NOTICE and the notice exists
            · cache "banned", audit log, optional admin alert
```

`revoke_messages = true` is still passed even though a fresh joiner has no history. It
costs nothing and it is correct if the account is rejoining after an earlier stint.

Deleting the join notice matters more than it sounds: without it, the chat is left with
a "X joined the group" service message for an account that no longer exists, which
looks like the bot failed.

**1b. On join request** (`chat_join_request`, groups with approval enabled)

Strictly better than 1a, because the account is vetted *before* it is ever in the room:

```
violation? -> declineChatJoinRequest   (nothing to delete, nothing to ban)
clean?     -> approveChatJoinRequest, or leave the request for a human
              (APPROVE_CLEAN_JOIN_REQUESTS, default false)
```

The default is deliberately asymmetric: the bot declines on its own judgement but does
**not** auto-approve, so a clean scan does not become an endorsement. Human admins keep
the approval decision unless they opt into automation.

**Members who joined before the bot did** never produce a join event. They are covered
by Trigger 2 — the first time such an account posts, it is scanned. The two triggers
together are what give complete coverage of an existing group.

---

## Trigger 2 — a user posts

Every ordinary message runs both tracks:

- **Track A** scans the attached image, if any, against `NSFW_THRESHOLD` → warning.
- **Track B** scans the *sender's account*, if not already cached → ban.

Track B on every message is what makes the bot work on a group it was added to
mid-life, and what catches an account that changed its avatar after joining. It is also
the expensive part: done naively it means `getChat` + `getUserProfilePhotos` + an
avatar download + a model run **per message**, including every text-only message from
a member cleared minutes ago.

The [verdict cache](#the-verdict-cache) is what makes it affordable. In steady state,
Track B on a message from an established member is a single cache lookup.

When Track B flags the sender, the triggering message is deleted and the account is
banned with `revoke_messages = true` — which is the mechanism that removes the rest of
their posts. Track A's verdict on that same message becomes irrelevant and is logged
but not acted on; there is no point warning about a photo posted by an account that is
being removed.

---

## Request flow

```
                    Telegram Bot API
                          │  POST update (JSON)
                          ▼
        ┌───────────────────────────────────────────┐
        │  Edge Function: netlify/edge-functions/   │
        │                 webhook.ts                │
        └───────────────────────────────────────────┘
                          │
          1. method + content-type check ──────────► 405 / 415
                          │
          2. secret-token header == env? ──────────► 401  (no body read)
                          │
          3. parse update, demultiplex, read chat.id
                          │
          4. chat.id ∈ ALLOWED_CHAT_IDS? ──── no ──► 200 OK, log "skipped: chat"
                          │ yes
          5. resolve subjects:
               join       -> the joining user(s)
               message    -> message.from, plus forward_origin author
                          │
          6. exempt? (admin / owner / EXEMPT_USER_IDS / self / bot)
                          │            └── yes ──► skip Track B
                          │
          7. ─── respond 200 OK now ───────────────► Telegram is done waiting
                          │
                          │  (remaining work continues on the same invocation)
                          │
          ┌───────────────┴───────────────────────────────┐
          ▼                                               ▼
   TRACK B — account                              TRACK A — message media
   (join, join request, or post)                  (post only)
                          │                                    │
   8b. verdict cache lookup by user_id             8a. extract a scannable file_id
       fresh hit -> reuse, no API calls                │  none -> log, done
                          │                                    │
   9b. getChat(user_id)         -> bio             9a. getFile + download
       getUserProfilePhotos     -> avatar         10a. decode -> classify
                          │                                    │
  10b. bio    -> URL extract -> blocklist         11a. score >= NSFW_THRESHOLD?
       avatar -> decode -> classify                     ├── no  -> log "clean"
                          │                              └── yes -> log + reply
  11b. harmful link  OR  avatar score                          WARNING_MESSAGE
       >= PROFILE_NSFW_THRESHOLD ?                             (suppressed if
       ├── no  -> cache "clean", done                           Track B is banning
       └── yes -> ENFORCE:                                      this sender)
                  · deleteMessage(trigger msg
                    or join notice)
                  · banChatMember(revoke_messages)
                  · cache "banned"
                  · audit log + optional alert
                  (all no-ops under DRY_RUN)
```

Steps 2–6 are cheap and synchronous: an update from an unknown chat costs one JSON
parse and one integer-set lookup. **Nothing is fetched for a non-whitelisted chat.**

Step 7 is the important ordering decision. Telegram treats a slow or missing `200` as a
delivery failure and redelivers the update, so acknowledging before the expensive work
avoids a retry storm on cold starts. The cost is that a failure after step 7 cannot be
signalled to Telegram — it is a log line only, and it is why enforcement writes an
audit record independently of whether the API calls succeeded.

---

## Trust boundary and the whitelist

Everything arriving at the endpoint is untrusted. The bot's username is public, so
anyone can add it to their own group, and Telegram will faithfully forward those
updates to your deployment. The bot holds ban rights, so the whitelist is not merely a
cost control — it is what stops a stranger from getting a banning bot into their chat.

Two independent gates:

1. **`TELEGRAM_WEBHOOK_SECRET`** — proves the request came from Telegram and not from
   someone POSTing hand-written JSON at the URL. Compared before the body is read, and
   with a length-independent comparison so the check leaks nothing by timing.
2. **`ALLOWED_CHAT_IDS`** — proves the *chat* is one you care about. Parsed once at
   cold start into a `Set<number>`, and applied to every update type, including join
   and membership updates.

Notes:

- The whitelist is an allowlist, never a denylist. An unset or malformed
  `ALLOWED_CHAT_IDS` yields an empty set, so the bot processes **nothing**. Failing
  closed is intentional, and doubly so now that any processed update can end in a ban.
- Rejections return `200 OK`, not `403`. A non-2xx would make Telegram retry the same
  update forever and eventually put the webhook into an error state.
- `LEAVE_UNLISTED_CHATS` (default `true`) makes the bot call `leaveChat` when
  `my_chat_member` shows it was added somewhere unlisted. This is defence in depth:
  the whitelist already prevents processing, but leaving also prevents the bot from
  accumulating admin rights in groups its operator does not know about.
- The token appears only in outbound URLs to `api.telegram.org` and must never be
  logged. Log lines carry chat/user/message IDs, not credentials.

---

## Identifying who to scan

**Join event.** `chat_member.new_chat_member.user`, or each entry of
`message.new_chat_members`. Note that `new_chat_members` is an *array* — one service
message can add several users, and each is scanned independently.

**Ordinary message.** `message.from` is the sender, and the actionable account: a
member of your chat, so it can be deleted from and banned.

**Forwarded message.** `message.forward_origin` (Bot API 7.0+) describes the original
author, in one of four shapes:

| `forward_origin.type` | Origin author available? | Scannable | Actionable in your chat |
|---|---|---|---|
| `user` | `sender_user` (full `User`) | Yes — avatar + bio | No, unless also a member |
| `hidden_user` | `sender_user_name` only, **no `user_id`** | **No** | No |
| `chat` | `sender_chat` (a group) | Chat photo + description | No |
| `channel` | `chat` (a channel) | Chat photo + description | No |

So a forwarded message has up to **two** subjects: the *forwarder* (always actionable)
and the *origin author* (scannable but usually not a member). The bot scans both when
it can, and `FORWARD_ORIGIN_ACTION` decides what a bad origin means for the member who
forwarded it:

- `delete` (default) — delete the forwarded message, leave the forwarder alone. A
  member may be forwarding spam precisely in order to complain about it.
- `delete_and_ban` — treat forwarding content from a flagged account as the
  forwarder's own violation.
- `ignore` — scan the forwarder only.

`hidden_user` origins are the deliberate hole: Telegram withholds the `user_id` when
the original author has account-linking disabled, and there is no Bot API route around
it. Logged as `origin_unresolvable`; only the forwarder is scanned.

Also skipped as subjects: the bot itself, anonymous admin posts (`sender_chat` equal to
the group), channel auto-forwards from a linked channel, and — unless `SCAN_BOTS` is
set — other bot accounts, which have no meaningful bio and are added deliberately by
admins.

---

## Account scan: profile photo

Two ways to reach a user's avatar, in order:

1. **`getUserProfilePhotos(user_id, limit=PROFILE_SCAN_DEPTH)`** →
   `UserProfilePhotos { total_count, photos }`, where `photos` is an array of
   size-arrays. The bot takes the newest photo and, within it, the largest size under
   `MAX_FILE_BYTES`. `total_count = 0` means no photo — which is *not* a violation,
   just an absent signal.
2. **`getChat(user_id)`** → `ChatFullInfo.photo` (`big_file_id` / `small_file_id`), a
   fallback, and needed anyway for the bio.

`PROFILE_SCAN_DEPTH` (default `1`) controls how many recent profile photos are
examined. Raising it catches an account that pushed a clean photo on top of explicit
ones, at a proportional cost in downloads and classifications.

Download, decode and classify are identical to Track A — same model, same decoders (see
[Image decoding](#image-decoding-in-the-edge-sandbox)) — but the verdict is compared
against `PROFILE_NSFW_THRESHOLD` (default `0.9`, versus `0.7` for message content).
The gap is intentional: a warning under a photo is cheap to be wrong about, a ban is
not.

Practical limits worth knowing:

- **Privacy settings.** A user can restrict who sees their profile photo. When
  Telegram withholds it, `total_count` is `0` and the account cannot be judged on its
  avatar. Logged as `profile_photo_unavailable` and **never** escalated to a violation.
  This is the obvious evasion: an account with a hidden avatar is unjudgeable by
  Track B's image half, and only its bio can be checked.
- **Avatars are small.** Telegram serves profile photos at modest resolution, a harder
  input for the classifier than a full-size photo. Expect more borderline scores here
  than on message media — another reason for the higher threshold.
- **`getChat` on a stranger can fail.** If the bot has never shared context with the
  user, `getChat` may return `400 Bad Request: chat not found`. Treated as "bio
  unavailable", not as a violation. This is more likely on a `chat_join_request`, where
  the account is not yet in the chat at all — see
  [open question 7](#open-questions).

---

## Account scan: bio and links

`getChat(user_id)` returns `ChatFullInfo.bio` for a user the bot can resolve. For a
`chat` or `channel` origin the equivalent field is `description`. Both are plain text
with no entity offsets, so URLs must be found by pattern rather than read off the
message structure.

**Extraction and normalisation.** Spam bios obfuscate links, so raw substring matching
is not enough:

1. Unicode-normalise (NFKC) to fold lookalike characters.
2. Replace common dot-substitutes — `[.]`, `(dot)`, `․` (U+2024), `。` — with `.`, and
   strip zero-width characters.
3. Match URLs *and* bare hosts, including `t.me/…`, `@username` handles, and schemeless
   `example.com/path`.
4. Reduce each hit to a registrable domain and compare **the domain and each of its
   parent domains** against the blocklist, so one entry covers subdomains.

**Checking.** Two mechanisms, independent:

- **`LINK_BLOCKLIST` / `LINK_BLOCKLIST_URL`** — a local list of domains, inline or
  fetched at cold start. The default, and it keeps the deployment's no-external-service
  property intact.
- **`SAFE_BROWSING_API_KEY`** — when set, unknown domains are additionally checked
  against Google Safe Browsing. This **sends domains extracted from user bios to
  Google**, a real privacy change from the local-only default, so it is off unless
  explicitly configured and is called out in the README.

A bio can also earn a violation structurally, gated by `BIO_RULES`: a link count above
`BIO_MAX_LINKS`, or an invite-link pattern (`t.me/joinchat/…`, `t.me/+…`) when
`BIO_BLOCK_INVITES` is on. Both are blunt and disabled by default.

The bio check is deliberately **text-only and local**. It does not fetch the linked
page: following a hostile URL from inside your infrastructure is exactly what the
sender wants, and it would leak your edge node's address.

---

## Enforcement: delete and ban

When Track B returns a violation and `DRY_RUN` is false:

```
1. deleteMessage(chat_id, message_id)
     the message that exposed the account, or the "X joined" notice.
     Best-effort: fails after 48h, or without can_delete_messages.

2. banChatMember(chat_id, user_id, revoke_messages = true)
     the ban itself. revoke_messages is what deletes the account's
     message history from the chat — there is no Bot API method that
     deletes a user's past messages independently, so the ban is the
     mechanism for "delete all messages from the account".

3. audit log + optional sendMessage(ADMIN_ALERT_CHAT_ID, …)
     always, including when 1 or 2 failed.
```

Things this order encodes:

- **The ban is the delete.** `revoke_messages = true` is the only Bot API route to
  clearing an account's history, and it is a parameter of `banChatMember` — you cannot
  wipe history without banning. With `REVOKE_MESSAGES=false` the account is banned but
  its posts stay visible.
- **Step 1 is not redundant.** Step 2 covers the history, but doing step 1 first means
  the offending message is gone at the earliest possible moment, even if the ban then
  fails on a permissions error.
- **`deleteMessages`** (plural, up to 100 IDs) exists but is unused: it still requires
  knowing the message IDs, and the bot keeps no message index. `revoke_messages` does
  the same job without the bookkeeping.
- **48 hours.** `deleteMessage` cannot remove a message older than 48 hours. Only the
  triggering message is affected — an edit to an old post can surface a violation whose
  original is now undeletable. Logged as `delete_expired`; the ban and revoke still
  proceed.
- **Bans are chat-scoped.** `banChatMember` bans the user from *that* chat. An account
  caught in one whitelisted group is not banned in the others. `BAN_SCOPE=all_chats`
  extends enforcement to every chat in `ALLOWED_CHAT_IDS`, at the cost of one
  `banChatMember` per chat and a ban in groups the account never entered.
- **Admins cannot be banned.** `banChatMember` fails against the chat owner and other
  administrators. Those accounts are exempt anyway, so this path should be unreachable;
  reaching it is logged at `error`, because it means the exemption check is wrong.
- **Failures are not retried in a loop.** Each call is attempted once. A `429` with
  `retry_after` is honoured once, then abandoned. The verdict is already in the audit
  log, and a retry loop inside a constrained invocation risks the deadline.

---

## The verdict cache

Track B runs on **every join and every message**. Without a cache that means
`getChat` + `getUserProfilePhotos` + an avatar download + a model run per message —
untenable on a free tier, and it would hit Telegram's per-bot rate limits on any busy
group.

So Track B is fronted by a per-user verdict cache in **Netlify Blobs**:

```
key   profile:<user_id>
value { verdict: "clean" | "flagged" | "unavailable",
        score, reason, photo_file_unique_id, checked_at }
```

- **Fresh `clean`** → Track B is skipped outright. This is the overwhelmingly common
  case and it is what makes the feature affordable.
- **`flagged`** → the account was already banned. The message is deleted, no rescan
  and no second ban.
- **`unavailable`** (privacy settings, `getChat` failure) → cached with a shorter TTL,
  because it is a transient condition rather than a judgement.
- **TTL** is `PROFILE_CACHE_TTL_SECONDS` (default `86400`). An account can change its
  avatar after being cleared, and the TTL is the window in which that goes unnoticed.
  `photo_file_unique_id` is stored so a rescan can be skipped when the avatar is
  provably the same file — the common case, which makes the rescan cheap even when the
  TTL expires.

The cache is also what makes the **dual join paths** and **album floods** free: a
second signal about an already-scanned account resolves to a lookup.

This is the component that makes the bot **stateful**, and that is a real
architectural cost: a new dependency, a new failure mode, and cross-invocation state
where there was none. It is accepted because the alternative does not work at any
traffic level worth having.

Cache failures fail **open toward doing the work**: if Blobs is unreachable, the bot
scans rather than assuming clean. Availability of `@netlify/blobs` inside the Edge
runtime is [open question 8](#open-questions); the fallback is a module-scope `Map` per
isolate, far weaker (lost on every recycle) but never wrong in the dangerous direction.

---

## Model hosting and cold start

nsfwjs needs a `model.json` plus weight shards (a few megabytes for the MobileNetV2
variant), and the WASM TFJS backend needs its `.wasm` binaries.

Two strategies, selected by whether `MODEL_BASE_URL` is set:

**A. Bundled (default).** Weights ship as assets alongside the function. Fastest, no
external dependency, but counts against the Edge Function bundle limit. If a deploy is
rejected for size, switch to B.

**B. Remote (`MODEL_BASE_URL` / `TFJS_WASM_BASE_URL`).** Weights are fetched over HTTP
on first use from a CDN, Netlify Blobs, or any static host. Keeps the bundle small at
the cost of a fetch on every cold isolate. The URL must be publicly reachable from the
edge, with long-lived cache headers.

**Warm-isolate caching.** The loaded model is held in a module-scope promise:

```
let modelPromise: Promise<NSFWJS> | null = null;
const getModel = () => (modelPromise ??= nsfwjs.load(...));
```

A single promise (not an awaited value) means concurrent requests on the same isolate
share one load instead of racing into several. If the load rejects, the promise is
cleared so the next request retries rather than inheriting a poisoned cache.

This is a cache, not a guarantee — Netlify recycles isolates freely, so budget for a
full model load on an unknown fraction of requests. Two consequences:

- Acknowledging Telegram before loading the model (step 7) is a correctness
  requirement, not an optimisation.
- The verdict cache matters more than it first appears: a cache hit skips the model
  load entirely, which is why text-only traffic costs almost nothing.

---

## Image decoding in the Edge sandbox

nsfwjs wants a pixel tensor. Getting from downloaded bytes to that tensor is the least
comfortable part of running on the edge: `tf.node.decodeImage` needs the native
binding and `canvas` needs Node.

In order of preference:

1. **Pure-JS decoders**, chosen by sniffing magic bytes: `jpeg-js` for JPEG, `upng-js`
   for PNG. Both are small, run unmodified on Deno, and cover the overwhelming majority
   of Telegram photos *and* profile photos, which Telegram re-encodes to JPEG itself.
2. **WEBP** — used by static stickers — has no comparable pure-JS decoder. Preferred
   workaround: read the sticker's `thumbnail`, which Telegram provides as JPEG. If
   there is none, the file is skipped and logged as `unsupported_format`, never assumed
   clean.
3. **Platform `ImageDecoder` / `createImageBitmap`**, if available in the Edge runtime,
   would replace 1 and 2 entirely. Availability unverified — see
   [Open questions](#open-questions).

After decoding: resize to the model's 224×224 input, drop alpha, build the tensor.
Tensors are disposed explicitly (`tf.dispose` / `tf.tidy`) — leaking them across a
long-lived warm isolate is a slow memory climb that ends with the isolate killed
mid-request.

---

## Classification and thresholds

nsfwjs returns five scores summing to ~1:

| Class | Meaning |
|---|---|
| `Neutral` | Nothing of interest |
| `Drawing` | Non-explicit illustration |
| `Sexy` | Suggestive; swimwear, lingerie, gym photos |
| `Hentai` | Explicit illustration |
| `Porn` | Explicit photography |

The verdict is one comparison, against a different threshold per track:

```
score   = max(scores[c] for c in NSFW_CLASSES)
flagged = score >= (track B ? PROFILE_NSFW_THRESHOLD : NSFW_THRESHOLD)
```

`max` rather than a sum, so adding a class to `NSFW_CLASSES` cannot flag an image purely
by accumulating small unrelated probabilities.

Defaults — `NSFW_CLASSES=Porn,Hentai`, `NSFW_THRESHOLD=0.7`,
`PROFILE_NSFW_THRESHOLD=0.9` — are biased toward missing borderline content rather
than acting on a beach photo. `Sexy` is excluded by default and should stay excluded
for Track B unless you are willing to ban members over swimwear avatars.

`DRY_RUN=true` runs every trigger and both tracks end to end — download, classify,
decide — and logs the verdict **without replying, deleting, declining or banning**.
Because Track B is on by default, the documented rollout is: dry-run against real
traffic, grep `"event":"enforcement"` for the accounts that would have been removed,
adjust `PROFILE_NSFW_THRESHOLD`, then enable enforcement.

---

## Media extraction rules

Track A scans at most one `file_id` per update. Resolution order:

| Field | Rule |
|---|---|
| `message.photo[]` | Telegram sends an ascending array of sizes. Pick the **largest whose `file_size` ≤ `MAX_FILE_BYTES`**. |
| `message.sticker` | Static: the sticker file. Animated (`is_animated`) or video (`is_video`): the `thumbnail`. `.tgs` is a Lottie archive and is never decoded. |
| `message.document` | Only when `mime_type` matches `image/*`. Documents are pass-through and unre-encoded, so this is the path an adversary would pick; the format sniff runs on the actual bytes, not the declared MIME type. |
| `message.video`, `message.animation` | The `thumbnail` only. A partial control: a video with an innocuous first frame passes. |
| Anything else | Skipped. |

`SCAN_MEDIA_TYPES` can narrow this set. Each skip reason is logged distinctly
(`skipped: media_type_disabled`, `skipped: too_large`, `skipped: unsupported_format`)
so "why did nothing happen?" is answerable from the logs alone.

Media groups (albums) arrive as several updates sharing a `media_group_id`. Each is
classified independently, so an album of three explicit images produces three warnings.
Collapsing them needs cross-invocation state and is out of scope. Track B does not have
this problem: the verdict cache dedupes the account scan across the whole album.

---

## Safeguards against wrongful bans

Track B is on by default and can remove a real person from a group and erase their
history on the strength of a heuristic score. These are the mechanisms that make that
survivable, and none should be removed casually.

1. **A stricter threshold.** `PROFILE_NSFW_THRESHOLD` defaults to `0.9` against `0.7`
   for message content.
2. **`DRY_RUN`.** Covers every trigger and both tracks. The documented rollout starts
   here, precisely because enforcement is the default behaviour.
3. **Exemptions**, checked *before* any scanning:
   - the chat owner and all administrators (via `getChatMember`),
   - every ID in `EXEMPT_USER_IDS`,
   - the bot itself, and other bots unless `SCAN_BOTS` is set,
   - optionally, accounts whose membership predates `EXEMPT_JOINED_BEFORE`, so a
     newly-deployed bot cannot ban long-standing members over an old avatar. This
     matters specifically because Trigger 2 scans *every* existing member the first
     time they post — without it, a deploy into a large old group is a mass-ban risk.
4. **`ENFORCEMENT_REASONS`.** Selects which findings escalate to a ban —
   `profile_nsfw`, `harmful_link`, and optionally `message_nsfw`. Setting it to
   `harmful_link` alone runs image detection in report-only mode while enforcing on
   links, which are a far more objective signal.
5. **A per-chat enforcement budget.** `MAX_BANS_PER_HOUR` (default `10`) caps
   enforcement per chat per hour. Beyond it, violations are logged and alerted but not
   acted on. This is the circuit breaker for a misconfiguration or a bad threshold: it
   turns "the bot emptied my group overnight" into "the bot banned ten people and
   started shouting".
6. **An audit line per enforcement**, carrying the user ID, trigger, reason, score or
   matched domain, and the avatar's `file_unique_id` — enough for a human to review and
   reverse a ban.
7. **`ADMIN_ALERT_CHAT_ID`.** When set, every enforcement is announced to a private
   admin chat with that detail, so bans are visible as they happen.
8. **Decline rather than ban, where possible.** Trigger 1b declines a join request
   instead of banning, and does not auto-approve clean accounts by default.
9. **Unban is manual and deliberate.** There is no self-service appeal flow; reversing
   a ban means a human calling `unbanChatMember` or using the Telegram client. The
   audit trail is what makes that possible.
10. **A broken classifier never bans.** A model load failure, a decode failure, an
    unavailable avatar, or a `getChat` error all resolve to "no verdict" and are logged.
    The bot never treats an inability to check as a reason to act.

---

## Idempotency and retries

- Answering `200` early makes Telegram-side retries rare, since the usual trigger is a
  slow response.
- **Duplicate join signals are expected**, not exceptional: `chat_member` and
  `new_chat_members` can both fire for one join. The cache absorbs the second.
- `banChatMember` is idempotent in effect — banning an already-banned user succeeds
  without changing anything — so a duplicate enforcement is harmless even on a cache
  miss.
- `deleteMessage` on an already-deleted message returns an error, logged at `debug`
  rather than `error`.
- A duplicate delivery costs a cache lookup and, on Track A, at worst a duplicate
  warning reply.

---

## Failure modes and how each is handled

| Failure | Handling | Why |
|---|---|---|
| Missing/incorrect secret header | `401`, body never read | Cheapest possible rejection of forged traffic |
| Malformed JSON | `400`, logged at `warn` | Not a Telegram-shaped request |
| Chat not whitelisted | `200`, logged at `info`; optionally `leaveChat` | Non-2xx would trigger endless retries |
| Unhandled update type | `200`, logged at `debug` | Most traffic is uninteresting service messages |
| No scannable media (Track A) | `200`, logged at `debug` | The common case |
| File over `MAX_FILE_BYTES` | Skipped, logged at `info` | Bounds memory and time on a constrained isolate |
| `getFile` / download fails | Logged at `error`, **no action** | Transient; never escalates to a ban |
| Model fails to load | Logged at `error`, cached promise cleared, **no action** | Nothing is declared clean *or* banned because the classifier is broken |
| Unsupported image format | Logged at `info` as `unsupported_format` | Distinguishable from "classified clean" |
| Classification throws | Logged at `error`, tensors disposed, **no action** | Prevents a leak surviving on a warm isolate |
| Avatar hidden by privacy | Cached `unavailable` (short TTL), logged at `info` | Absence of a signal is not a violation |
| `getChat` returns `chat not found` | Bio treated as unavailable, logged at `info` | The bot cannot resolve every stranger |
| Forward origin is `hidden_user` | Logged `origin_unresolvable`, forwarder still scanned | Telegram withholds the `user_id` |
| **`chat_member` updates never arrive** | Startup check logs at `error`; `new_chat_members` fallback carries joins | Missing from `allowed_updates`, or the bot is not an admin — the most likely misconfiguration |
| Blobs cache unreachable | Scan anyway, logged at `warn` | Fails toward doing the work, not toward trusting an unknown account |
| Bot lacks admin rights | Enforcement fails; logged at `error` + startup/promotion warning | Surfaced at deploy time, not at the moment of a ban |
| `banChatMember` on an admin | Logged at `error` | Should be unreachable; means the exemption check is broken |
| `deleteMessage` past 48h | Logged `delete_expired`; ban still proceeds | API limit, not a bug |
| `MAX_BANS_PER_HOUR` exceeded | Violation logged and alerted, **not enforced** | Circuit breaker against a mass ban |
| `429 Too Many Requests` | `retry_after` honoured once, then abandoned | A retry loop would blow the invocation deadline |

The rule underneath the table: **absence of an action never means "verified clean", and
an inability to check never justifies enforcement.** Every reason a scan did not
complete has its own log line.

---

## Observability and the audit trail

Netlify → **Logs → Edge Functions** is the only sink; there is no metrics backend. Two
kinds of structured line, both JSON.

**Per-update verdict:**

```json
{
  "level": "info", "event": "verdict",
  "chat_id": -1001234567890, "message_id": 4821, "user_id": 55512345,
  "trigger": "message", "track": "B",
  "flagged": false, "score": 0.11, "class": "Porn",
  "action": "none", "cache": "miss",
  "ms": { "profile_fetch": 90, "download": 210, "decode": 45,
          "classify": 130, "model_load": 0 },
  "dry_run": false
}
```

**Per-enforcement audit line** — the record a human needs to review or reverse a ban:

```json
{
  "level": "warn", "event": "enforcement",
  "chat_id": -1001234567890, "user_id": 55512345,
  "trigger": "join",
  "reason": "profile_nsfw",
  "score": 0.96, "class": "Porn",
  "photo_file_unique_id": "AQADBAADr…",
  "matched_domain": null,
  "actions": { "delete": "ok", "ban": "ok", "revoke_messages": true },
  "budget_remaining": 7,
  "dry_run": false
}
```

`trigger` is one of `join`, `join_request`, `message`, `edited_message` or `forward` —
which is how you tell "caught at the door" from "caught after posting", the single most
useful signal for judging whether join scanning is working.

For a link violation, `reason` is `harmful_link`, `matched_domain` carries the domain,
and `score` is null.

- Never logged: the bot token, the webhook secret, message text, bio text, usernames,
  or any image bytes. A matched *domain* is logged; the surrounding bio is not.
- `LOG_LEVEL=debug` adds the full per-class score vector — the input for calibrating
  both thresholds.
- `ms.model_load > 0` marks a cold start. `cache` marks whether Track B did real work.
- `dry_run: true` on an `enforcement` line means "this account *would* have been
  banned". Grepping for those is the calibration workflow.
- Netlify log retention is finite. If ban records must outlive it, forward
  `enforcement` lines to a log drain or mirror them to `ADMIN_ALERT_CHAT_ID` — a
  Telegram chat keeps history indefinitely.

---

## Planned file layout

Documentation-only at this stage; nothing below exists yet.

```
.
├── README.md                       # deploy + operate
├── ARCHITECTURE.md                 # this file
├── .env.example                    # documented variable template
├── netlify.toml                    # edge function route, Deno settings
├── deno.json                       # imports map, tasks, fmt/lint config
├── netlify/
│   └── edge-functions/
│       └── webhook.ts              # the only entry point
├── src/
│   ├── config.ts                   # env parsing + validation, once per cold start
│   ├── router.ts                   # update -> handler demultiplexing
│   ├── handlers/
│   │   ├── join.ts                 # chat_member + new_chat_members
│   │   ├── join_request.ts         # chat_join_request -> approve / decline
│   │   ├── message.ts              # Track A + Track B on a post
│   │   └── my_member.ts            # own rights check, leave unlisted chats
│   ├── telegram/
│   │   ├── verify.ts               # secret-token comparison
│   │   ├── subjects.ts             # update -> {joiners, sender, origin}
│   │   ├── extract.ts              # update -> {file_id, media_type} | null
│   │   └── api.ts                  # getFile, download, getChat,
│   │                               # getUserProfilePhotos, getChatMember,
│   │                               # sendMessage, deleteMessage, banChatMember,
│   │                               # approve/declineChatJoinRequest, leaveChat
│   ├── detector/
│   │   ├── model.ts                # cached load, backend selection
│   │   ├── decode.ts               # magic-byte sniff -> RGB pixels
│   │   └── classify.ts             # scores -> verdict
│   ├── links/
│   │   ├── normalize.ts            # NFKC, dot-substitutes, URL/host extraction
│   │   └── blocklist.ts            # domain + parent-domain matching
│   ├── enforce/
│   │   ├── exempt.ts               # admin / EXEMPT_USER_IDS / self / bot checks
│   │   ├── budget.ts               # MAX_BANS_PER_HOUR circuit breaker
│   │   ├── actions.ts              # delete -> ban(revoke) -> audit
│   │   └── cache.ts                # Netlify Blobs verdict cache
│   └── log.ts                      # levelled structured logging + audit lines
├── fixtures/                       # saved updates: message, join, join_request
└── tests/                          # unit tests for the pure functions
```

The split follows the trust boundary and the blast radius. `verify.ts`, `config.ts`,
`subjects.ts`, `exempt.ts`, `budget.ts`, `normalize.ts` and `blocklist.ts` are the
parts that must be correct for the whitelist to hold and for the bot not to ban the
wrong person — and they are all pure functions, unit-testable without a network or a
model. `actions.ts` is the only module that can delete, ban or decline, so it is the
only one needing an audit for destructive behaviour.

---

## Configuration surface

All configuration is environment variables — no config file, no per-chat overrides, no
runtime mutation. Rationale: the deployment story in the README is "set a few variables
and register a webhook", and a config file in the repo would mean every operator
carries a diff against upstream forever.

`config.ts` parses and validates everything **once at cold start** and fails loudly on
a value it cannot use, so a typo in `PROFILE_NSFW_THRESHOLD` surfaces as one clear
error rather than as `NaN` quietly comparing false — or, worse, as an unintended ban.

Validation rules that exist specifically because enforcement is the default:

- `PROFILE_NSFW_THRESHOLD` below `NSFW_THRESHOLD` is refused at startup: banning on
  weaker evidence than warning is almost certainly a misconfiguration.
- `MAX_BANS_PER_HOUR` of `0` is refused as ambiguous; use `DRY_RUN=true` to disable
  enforcement, which is explicit about intent.
- If `ALLOWED_CHAT_IDS` is empty, startup logs at `error` rather than `warn` — an empty
  whitelist means the bot does nothing at all, which is almost never intended.

The complete list, with defaults, lives in
[README.md § Environment variables](./README.md#environment-variables) and
[.env.example](./.env.example). Those are the single source of truth; this document
does not restate them.

---

## Fallback: the split deployment

If WASM TensorFlow.js cannot be made to work inside the Edge sandbox — or if the model
will not fit — the design degrades to two pieces rather than being rewritten:

```
Telegram ──► Edge Function  (Deno)                 ──► 200 OK immediately
             · secret check
             · whitelist check
             · update routing + subject resolution
             · exemption check
             · verdict cache lookup   (hit -> done, no further cost)
                    │  internal POST {trigger, user_id, file_id,
                    │                 chat_id, message_id}
                    ▼
             Netlify Function (Node runtime)
             · @tensorflow/tfjs-node + nsfwjs  (native, no WASM constraints)
             · profile fetch, download, decode, classify
             · bio + link check
             · enforcement (delete, ban, decline, audit)
```

The edge keeps what it is good at — rejecting unwanted traffic in microseconds and
answering cache hits without touching the model — and the Node function gets the
runtime the ML stack was built for: native TFJS, real image decoders, a filesystem to
cache weights in, and a longer execution budget.

This preserves the module boundaries above exactly; only the transport between
subject resolution and classification changes. That is why `detector/`, `links/` and
`enforce/` are separated from `telegram/` and `handlers/` in the first place.

---

## Open questions

Unresolved, and worth settling before or during implementation:

1. **Does WASM TFJS actually run in Netlify Edge Functions?** Instantiating a `.wasm`
   module from a fetched `ArrayBuffer` should be permitted, but this needs an empirical
   spike. It is the single assumption the whole Edge path rests on.
2. **Is `ImageDecoder` or `createImageBitmap` available at the edge?** If yes, the
   hand-rolled decoders and the WEBP gap both disappear.
3. **Real bundle size** with weights included, against the current Edge Function limit
   — decides whether `MODEL_BASE_URL` is optional or mandatory.
4. **Measured cold-start cost**, remote vs. bundled weights. If a cold scan routinely
   exceeds the invocation budget, that alone forces the split deployment.
5. **Does work after the response actually complete?** The early-`200` pattern assumes
   the isolate is not torn down the instant the response is returned. If it is, the
   options are to answer late (accepting Telegram retries) or to move to the split
   deployment. This matters here: a torn-down isolate could delete a message and never
   reach the ban.
6. **MobileNetV2 vs. Inception weights** — accuracy against size, probably settled by
   question 3. Avatars are low-resolution inputs, so the difference may matter more for
   Track B than Track A.
7. **`getChat(user_id)` and `getUserProfilePhotos` for a user not yet in the chat.**
   Trigger 1b (join request) scans an account *before* it is a member, and it is not
   clear that either call resolves reliably in that state. If they do not, join-request
   vetting collapses back to join-time scanning, and Trigger 1b should be off by
   default.
8. **Is `@netlify/blobs` usable from an Edge Function**, and what are its latency and
   consistency characteristics? The entire cost model of Track B depends on the verdict
   cache. Fallback is a per-isolate `Map`.
9. **What blocklist to ship as a default?** Shipping none makes `harmful_link`
   enforcement inert out of the box; shipping a third-party list makes the deployment
   depend on someone else's judgement about what to ban. Current lean: ship empty,
   document `LINK_BLOCKLIST_URL`.
10. **Should a ban be chat-scoped or account-scoped by default?** `BAN_SCOPE` exists,
    but the right default is a policy question about how much one flagged avatar should
    cost an account across an operator's groups.
11. **Rate limits under a join flood.** A wave of spam accounts joining at once means a
    burst of `getChat` + `getUserProfilePhotos` + `banChatMember` calls, and Telegram's
    limits are per bot, not per chat. `MAX_BANS_PER_HOUR` bounds the damage but does
    not pace the API calls; whether a queue is needed is unknown until there is real
    traffic.
12. **Deploying into an existing large group.** Trigger 2 scans every member the first
    time they post, so the first days after a deploy are the highest-risk window for
    false positives — precisely when the operator has least calibration data.
    `EXEMPT_JOINED_BEFORE` is the blunt mitigation; a "report-only for the first N
    hours" mode might be better and does not exist yet.
