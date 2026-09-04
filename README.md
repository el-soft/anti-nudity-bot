# nudity-detector-bot

A Telegram bot that keeps explicit-content and scam accounts out of your group chats.
It runs as a **Netlify Edge Function** on Deno, and classifies images **locally** with
[nsfwjs](https://github.com/infinitered/nsfwjs) — no server, no third-party moderation
API.

It watches **messages and join notifications** from your whitelisted groups:

- **When someone joins**, their profile photo and bio are checked. Bad account →
  **banned immediately**, before it can post.
- **When someone posts**, their profile is checked too. Bad account → the message is
  **deleted, their message history wiped, and the account banned**.
- **Message images** are also scanned on their own. Explicit ones get a **warning
  reply** — a bad photo is not treated as a bad account.

The bot must be a **group admin** for any of the banning to work. Run it with
`DRY_RUN=true` first.

Only chats you list in `ALLOWED_CHAT_IDS` are processed. Everything else is ignored.

Design details and known limitations: [ARCHITECTURE.md](./ARCHITECTURE.md).

> **Current status: implemented, uncalibrated.** Both tracks, all four triggers and
> every safeguard described below are in place, and `DRY_RUN=true` is the default.
> What has *not* happened is calibration against your group's real traffic: the
> thresholds shipped here are the design's guesses, not measurements. Run in dry-run
> for a day or two and read the `enforcement` log lines before enabling enforcement —
> [step 7](#7-dry-run-first) is that procedure.

---

## Usage

### 1. Fork this repo

Click **Fork** on GitHub. You deploy your own copy, with your own bot token.

### 2. Create your Telegram bot

Message [@BotFather](https://t.me/BotFather):

- `/newbot` → pick a name and a username → **copy the token**.
- `/setprivacy` → choose your bot → **Disable**.
  Without this the bot only sees messages that mention it, so it will never see the
  images it is meant to scan.

### 3. Deploy to Netlify

In Netlify: **Add new site → Import an existing project** → pick your fork → deploy.
Build settings come from `netlify.toml`.

Your webhook endpoint is:

```
https://<your-site>.netlify.app/telegram/webhook
```

### 4. Set environment variables

**Site configuration → Environment variables**, or from the CLI:

```bash
netlify env:set TELEGRAM_BOT_TOKEN      "<token from BotFather>"
netlify env:set TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
netlify env:set ALLOWED_CHAT_IDS        "-1001234567890"
netlify env:set DRY_RUN                 "true"
```

Start with `DRY_RUN=true`. Step 8 turns it off.

Then **redeploy** — variables are read at startup.

### 5. Connect the webhook

Join notifications are **not sent by default** — you have to ask for them by name.
This is the most common reason a join-scanning bot appears to do nothing:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://<your-site>.netlify.app/telegram/webhook",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": [
          "message", "edited_message",
          "chat_member", "my_chat_member", "chat_join_request"
        ]
      }'
```

Check it worked: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`

### 6. Add the bot to your group as an admin

**Manage group → Administrators → Add** your bot, with:

| Right | Why |
|---|---|
| **Delete messages** | Removing flagged messages and join notices |
| **Ban users** | The ban, and wiping the account's history |
| *(admin at all)* | `chat_member` join updates are **only delivered to admins**. A non-admin bot gets no join signal. |

Add it as a plain member and the join scanning silently will not work.

### 7. Dry-run for a day or two

Everything is live except the consequences. Post a test image, let people join, then
search **Netlify → Logs → Edge Functions** for:

- `"event":"enforcement"` — every one of these is an account that **would** have been
  banned. Recognise anyone? Raise `PROFILE_NSFW_THRESHOLD` before continuing.
- `"trigger":"join"` — join scanning is working. If you never see this, revisit
  steps 5 and 6.

### 8. Go live

```bash
netlify env:set EXEMPT_USER_IDS     "<your user id>,<other trusted ids>"
netlify env:set ADMIN_ALERT_CHAT_ID "<your private chat id>"
netlify env:set DRY_RUN             "false"
```

Group admins and owners are exempt automatically. `ADMIN_ALERT_CHAT_ID` gets a message
for every ban with the reason and score — that is your record for undoing mistakes.

To undo a ban: **Manage group → Removed users**, or the `unbanChatMember` API method.

> **Deploying into an existing large group?** Every member gets scanned the first time
> they post, so the first days are the highest-risk window for false positives. Set
> `EXEMPT_JOINED_BEFORE` to today's date to limit enforcement to new arrivals, or stay
> in dry-run longer.

---

## Environment variables

Required:

| Variable | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your BotFather token. Secret. |
| `TELEGRAM_WEBHOOK_SECRET` | Any long random string. Must match the `secret_token` you gave `setWebhook`. Blocks fake requests. |
| `ALLOWED_CHAT_IDS` | Comma-separated chat IDs to watch. Group IDs are negative, e.g. `-1001234567890`. Empty = nothing is processed. |

Account scanning → **ban** (defaults shown):

| Variable | Default | What it does |
|---|---|---|
| `SCAN_PROFILE` | `true` | Master switch for account scanning. |
| `SCAN_ON_JOIN` | `true` | Check profiles at join time. |
| `SCAN_JOIN_REQUESTS` | `true` | In groups with join approval, vet accounts before admitting them — decline instead of ban. |
| `APPROVE_CLEAN_JOIN_REQUESTS` | `false` | Auto-approve accounts that pass. Off by default: a clean scan is not an endorsement. |
| `DELETE_JOIN_NOTICE` | `true` | Also delete the "X joined the group" notice when banning a joiner. |
| `PROFILE_NSFW_THRESHOLD` | `0.9` | Ban threshold for profile photos. Stricter than `NSFW_THRESHOLD` on purpose — a ban is not a warning. Must be ≥ `NSFW_THRESHOLD`. |
| `PROFILE_SCAN_DEPTH` | `1` | How many recent profile photos to check. Higher catches a clean photo stacked on explicit ones. |
| `ENFORCEMENT_REASONS` | `profile_nsfw,harmful_link` | Which findings cause a ban. Add `message_nsfw` to also ban for message content. Set to `harmful_link` alone to report on images but only enforce on links. |
| `LINK_BLOCKLIST` | *(empty)* | Comma-separated bad domains for bio links. Subdomains are covered. Empty = link enforcement is inert. |
| `LINK_BLOCKLIST_URL` | — | Fetch the domain list from a URL instead. |
| `REVOKE_MESSAGES` | `true` | Delete the banned account's message history. This is what "delete all their messages" means — Telegram only offers it as part of a ban. |
| `BAN_SCOPE` | `this_chat` | `all_chats` bans the account in every whitelisted group, not just the one it appeared in. |
| `PROFILE_CACHE_TTL_SECONDS` | `86400` | How long a "clean" account is trusted before rescanning. |
| `SCAN_BOTS` | `false` | Also scan other bot accounts. |
| `SCAN_COMMAND` | `true` | The admin-only [`/scan` command](#the-scan-command). |

Message images → **warning** (defaults shown):

| Variable | Default | What it does |
|---|---|---|
| `NSFW_THRESHOLD` | `0.7` | Flag a message image above this score. |
| `NSFW_CLASSES` | `Porn,Hentai` | What counts as explicit. Add `Sexy` to be stricter (flags swimwear, gym photos). |
| `MESSAGE_ACTION` | `warn` | `warn`, `warn_and_delete`, `delete`, or `log`. |
| `WARNING_MESSAGE` | `⚠️ This image was flagged as adult content.` | The reply text. |

Safety rails:

| Variable | Default | What it does |
|---|---|---|
| `DRY_RUN` | `false` | `true` = log everything, ban/delete/decline nothing. **Start here.** |
| `EXEMPT_USER_IDS` | *(empty)* | Never scanned, never banned. Admins and owners already are. |
| `EXEMPT_JOINED_BEFORE` | — | Don't enforce against accounts that joined before this date. Use when deploying into an existing group. |
| `MAX_BANS_PER_HOUR` | `10` | Per-chat circuit breaker. Past it, violations are logged and alerted but not enforced. |
| `ADMIN_ALERT_CHAT_ID` | — | Chat that receives a notice for every ban. Strongly recommended. |
| `LEAVE_UNLISTED_CHATS` | `true` | Leave any group the bot is added to that isn't whitelisted. |
| `LOG_LEVEL` | `info` | `debug` logs per-class scores. |

Full list with comments: [.env.example](./.env.example).

## What gets scanned

**Accounts:** profile photo and bio text — at join, at join request, and on the first
message from an account that hasn't been scanned recently. On a forwarded message, the
original author's profile too, except when they've hidden their account (Telegram
allows this and the bot cannot work around it).

Results are cached per account, so members aren't re-scanned on every message.

**Message images:** photos, static stickers, and images sent as files. Videos, GIFs and
animated stickers are judged by their **thumbnail** only — a clean first frame passes.

**On demand:** admins can run [`/scan`](#the-scan-command) to check an account, or
sweep the accounts the bot has seen, without waiting for them to post.

**Not scanned:** an account that has hidden its profile photo in Telegram's privacy
settings. This is the obvious way around the image check; only the bio can be checked
for such accounts, and a hidden photo is never treated as a violation on its own.

## The /scan command

Group admins can ask the bot to check accounts on demand. It is admin-only — the
check is a live lookup on every use, so a demoted admin loses access immediately.

| Command | What it does |
|---|---|
| `/scan` **as a reply** to someone's message | Checks that account. The most reliable form: Telegram hands the bot the account itself, so there is nothing to look up and nobody to confuse them with. |
| `/scan <user_id>` | Checks that account. |
| `/scan` on its own | Sweeps the accounts the bot has seen in this group — up to 25 per run, so it fits inside one invocation. Run it again to continue. |

It obeys `DRY_RUN`, the exemptions, `ENFORCEMENT_REASONS` and `MAX_BANS_PER_HOUR`
exactly like automatic enforcement, and writes the same audit line — with
`"trigger":"scan_command"`, so a manual sweep is distinguishable from the bot acting
on its own. Unlike the automatic path it ignores the verdict cache and re-classifies
from scratch, because an admin running `/scan` has usually just changed a threshold.

The bot builds its own list of accounts to sweep, recording a user ID on every **join**,
every **join request**, and every **post**.

> **`/scan` on its own cannot mean "everyone in this group."** Telegram gives bots **no
> way to list a group's members** — `getChatMember` needs a user ID you already have,
> and only admins can be enumerated. So the sweep covers the accounts the bot has
> recorded, and nothing else. Members who have been silent since the bot was added are
> invisible to it. Every sweep reply says so, and to check one of them specifically,
> reply to any message of theirs with `/scan`.

Before touching anyone, a sweep checks they are still in the group. Accounts that have
left are skipped and dropped from the list rather than banned — `banChatMember` works
on non-members, so without that check a sweep would pre-emptively ban people who left
months ago.

To make it appear in Telegram's command menu, send `/setcommands` to
[@BotFather](https://t.me/BotFather), pick your bot, and paste:

```
scan - Check an account, or sweep the ones I've seen (admins only)
```

This is cosmetic — the command works whether or not you register it.

`/scan @username` is **not** supported, and deliberately: no Bot API method turns a
username into an account, so the bot would have to guess — and guessing is how the
wrong person gets banned. It says so and asks you to reply instead.

## Finding your chat ID

Easiest way: deploy with `LOG_LEVEL=debug`, add the bot to the group, post anything.
The "rejected chat" log line contains the ID. Put it in `ALLOWED_CHAT_IDS` and
redeploy.

## Local development

```bash
cp .env.example .env    # fill in your values; .env is gitignored
netlify dev             # serves http://localhost:8888/telegram/webhook

deno task check         # type-check the whole graph
deno task test          # unit tests, plus one real model run
deno task fmt           # format
```

The test suite covers the parts that must be right for the whitelist to hold and for
the bot not to ban the wrong person — config validation, secret comparison, subject
resolution, media extraction, link normalisation, the exemptions and the ban budget —
plus an end-to-end pass through the router with a stubbed Bot API.
`tests/classify_integration_test.ts` is the slow one: it loads the real model and
classifies a real JPEG, which is what proves the whole detection path runs on Deno
rather than only on Node.

**The verdict cache uses [Netlify Blobs](https://docs.netlify.com/blobs/overview/)**,
which needs nothing configured on a Netlify-deployed site. If it is unreachable the bot
falls back to a per-isolate in-memory cache and logs `blobs_unavailable` — correct, but
much more expensive, since a cold isolate then rescans accounts it has already cleared.

## Troubleshooting

| Problem | Fix |
|---|---|
| **Joins are never scanned** | Two causes, both required: `chat_member` must be in `allowed_updates` on `setWebhook` (step 5), **and** the bot must be a group admin (step 6). Check the logs for `"trigger":"join"`. |
| Bot ignores images in the group | Privacy mode is still on. `/setprivacy` → Disable in BotFather, then **remove and re-add** the bot to the group. |
| `getWebhookInfo` reports a `401` | `TELEGRAM_WEBHOOK_SECRET` doesn't match the `secret_token` you sent to `setWebhook`. |
| Logs say the chat was rejected | The ID isn't in `ALLOWED_CHAT_IDS`, or you didn't redeploy. Supergroup IDs keep the `-100` prefix. |
| Bans fail with `400 Bad Request` | The bot isn't an admin, or lacks **Ban users** / **Delete messages**. |
| Nobody is ever banned | `DRY_RUN` is still `true`, or `MAX_BANS_PER_HOUR` is exhausted — both say so in the logs. |
| `/scan` says it has seen nobody | The roster is built from sightings, and Telegram won't let a bot list members. Wait for people to post, or reply to a message with `/scan`. |
| A swept account is reported "no longer in the group" | They left. The bot skips them and drops them from its list; the next sweep won't mention them. |
| `/scan` does nothing at all | Non-admins get a refusal; check `"event":"scan_command_denied"`. If there is no log line at all, the chat isn't whitelisted, or `SCAN_COMMAND=false`. |
| An account was banned wrongly | Unban via **Manage group → Removed users**, add them to `EXEMPT_USER_IDS`, and raise `PROFILE_NSFW_THRESHOLD`. |
| Too many false positives | Remove `Sexy` from `NSFW_CLASSES`, raise the thresholds toward `0.95`, or set `ENFORCEMENT_REASONS=harmful_link` to stop banning on images entirely. |
| Nothing is ever flagged | Check the logs for a model-load error. A broken classifier is logged, never treated as "clean" — and never as a reason to ban. |
| Old avatars aren't caught | A cleared account is trusted for `PROFILE_CACHE_TTL_SECONDS`. Lower it, or raise `PROFILE_SCAN_DEPTH`. |
| Every message triggers a full rescan | The verdict cache isn't working. Look for `blobs_unavailable` or `cache_unavailable` in the logs. |
| First scan after a deploy is slow | Cold start: the WASM backend and the model weights load on the first classification of each isolate. `ms.model_load` in the log line marks it. Telegram is answered before any of it, so it costs latency on the scan, not a redelivery. |

## Privacy

Images are classified in memory and discarded — never stored, never sent to an outside
service. Logs record chat ID, user ID, media type, scores, and any matched domain —
not image content, message text, or bio text.

One exception: if you set `SAFE_BROWSING_API_KEY`, domains found in user bios are sent
to Google Safe Browsing. It is off by default.

Both checks are heuristics and will make mistakes. This bot bans people, so tell your
group it is running and who to contact about a wrong ban.

## License

See [LICENSE](./LICENSE).
