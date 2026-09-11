# nudity-detector-bot

A Telegram group bot on a Netlify Edge Function. It enforces one rule:

> **Somebody has to have let you in.**

An account added by an existing member, approved by an admin, or arriving through
an invite link stays. An account that walks in unaided — public group, username
search, QR code — is removed. Everything else the bot sees is written to the log
and nothing more.

A removal is a ban followed immediately by an unban: the account is out of the
group, but not blacklisted, so a member can still add them deliberately later.
**No messages are ever deleted.**

## Why this stops scammers

The scam pattern is a bot account joining a public group by itself, then DMing
the member list. It never involves a member vouching for it, because there is no
member to ask. Requiring somebody to have let you in costs a real member nothing
— they add friends the way they always did — and costs an unattended script the
one thing it cannot get.

## What it does, exactly

| Event                                              | Action                    |
| -------------------------------------------------- | ------------------------- |
| Added by an existing member                        | allowed                   |
| Join request approved by an admin                  | allowed                   |
| Moved in by a member through an invite link        | allowed (see below)       |
| Followed an invite or chat-folder link themselves  | **removed**               |
| Joined unaided — no link, no adder, no approval    | **removed**               |
| Arrived as an admin or the creator                 | allowed, always           |
| Listed in `EXEMPT_USER_IDS`                        | allowed, always           |
| Left, was removed, promoted, muted                 | logged only               |
| Messages, reactions, everything else               | logged only               |

The line is *who acted*, not which route was taken: an account that put itself
in the chat goes, whether it walked in or followed a link somebody shared.
`REMOVE_SELF_JOINS=false` relaxes that back to route-by-route judgement, where
`ALLOW_INVITE_LINK_JOINS` decides what happens to link joins.

Two deliberate holes, both configurable:

- **Invite links are trusted when somebody else carried the join out**
  (`ALLOW_INVITE_LINK_JOINS=true`). With `REMOVE_SELF_JOINS=true` — the default
  — that only covers a member moving someone in while a link is on the update;
  an account that followed the link itself is removed regardless. Set
  `ALLOW_INVITE_LINK_JOINS=false` to also drop those.
- **Service-message joins are not acted on.** When Telegram reports a join only
  as an in-chat "X joined the group" message, that message says who added whom
  and *nothing about which link was used*. Acting on it would remove invited
  people, so the bot logs it and waits for the `chat_member` update, which
  carries the real route. `REMOVE_UNDISCLOSED_JOINS=true` overrides this.

Join requests are left to your admins by default; `JOIN_REQUEST_ACTION=decline`
declines them all automatically.

## Usage

### 1. Create your Telegram bot

Message [@BotFather](https://t.me/BotFather):

- `/newbot` → pick a name and a username → **copy the token**.
- `/setprivacy` → choose your bot → **Disable**, if you also want the message
  traffic in the log. Enforcement works either way.

### 2. Deploy to Netlify

**Add new site → Import an existing project** → pick your fork → deploy. Build
settings come from `netlify.toml`. Your webhook endpoint is:

```
https://<your-site>.netlify.app/telegram/webhook
```

### 3. Set environment variables

**Site configuration → Environment variables**, or from the CLI:

```bash
netlify env:set TELEGRAM_BOT_TOKEN      "<token from BotFather>"
netlify env:set TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
netlify env:set ALLOWED_CHAT_IDS        "-1001234567890"
netlify env:set DRY_RUN                 "true"
```

Start with `DRY_RUN=true`. Step 6 turns it off. Then **redeploy** — variables are
read at startup.

### 4. Connect the webhook

Membership updates are **not sent by default** — you have to ask for them by
name. This is the most common reason the bot appears to do nothing:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://<your-site>.netlify.app/telegram/webhook",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": [
          "message", "edited_message",
          "chat_member", "my_chat_member", "chat_join_request",
          "message_reaction"
        ]
      }'
```

**`chat_member` is the one that matters.** It is the only update that says *how*
an account got in, and enforcement runs on it alone. Without it the bot sees
joins only as service messages, whose route Telegram does not disclose, and
removes nobody. `allowed_updates` replaces the whole list on every `setWebhook`
call, so a later call with a shorter list silently turns enforcement off.

Check it worked: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`

### 5. Add the bot to your group as an admin

It needs exactly one permission: **Ban users**. That is what both the ban and the
unban behind a removal require. Nothing else — it never deletes, pins, invites or
posts.

Find your chat ID from the log: add the bot, post anything, and read `chat_id`
off the `received` line under **Logs → Edge Functions**.

### 6. Dry-run, then go live

With `DRY_RUN=true` the bot decides and logs but calls nothing. Watch for a day:

```
{"event":"dry_run","action":"remove","reason":"joined_unaided","chat_id":-100…,"user_id":777…}
{"event":"allowed","reason":"added_by_member","chat_id":-100…,"user_id":888…}
```

Every `dry_run` line is somebody who *would* have been removed. When the
`reason`s all look right:

```bash
netlify env:set DRY_RUN "false"   # then redeploy
```

## Environment variables

| Variable                   | Required | Default  | Meaning                                                       |
| -------------------------- | -------- | -------- | ------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | yes      | —        | From BotFather                                                |
| `TELEGRAM_WEBHOOK_SECRET`  | yes      | —        | Must equal the `secret_token` given to setWebhook             |
| `ALLOWED_CHAT_IDS`         | yes      | —        | Comma-separated chat IDs to police; others are logged only     |
| `DRY_RUN`                  | no       | `true`   | Decide and log, but change nothing                            |
| `REMOVE_SELF_JOINS`        | no       | `true`   | Remove an account that put itself in, whatever route it used   |
| `ALLOW_INVITE_LINK_JOINS`  | no       | `true`   | Treat an invite-link join as invited                          |
| `REMOVE_UNDISCLOSED_JOINS` | no       | `false`  | Act on service-message joins, whose route is unknown          |
| `JOIN_REQUEST_ACTION`      | no       | `ignore` | `ignore` (leave to admins) or `decline`                       |
| `EXEMPT_USER_IDS`          | no       | —        | Never removed                                                 |
| `MAX_REMOVALS_PER_HOUR`    | no       | `20`     | Circuit breaker, per running instance                         |
| `LOG_LEVEL`                | no       | `info`   | `debug`, `info`, `warn` or `error`                            |

A missing or invalid value is fatal: the function then answers 200 and logs a
`config_error` line per problem instead of processing updates. 200 rather than
500, because a non-2xx makes Telegram retry the same update forever.

## Reading the log

One JSON object per line. Every update produces a `received` line; every
membership change also produces one of `allowed`, `dry_run`, `enforced` or a
failure.

```json
{"level":"info","ts":"…","event":"received","update_id":100237,"message_type":"joined",
 "chat_id":-1001234567890,"user_id":777888999,"detail":"via=chat_member,left->member,by=777888999,route=unaided"}
{"level":"info","ts":"…","event":"enforced","action":"remove","reason":"joined_unaided",
 "chat_id":-1001234567890,"user_id":777888999}
```

`route` is the whole decision: `unaided`, `invite_link`, `added_by_member`,
`join_request`, `chat_folder`, or `undisclosed`. `reason` says what the policy
made of it — `joined_unaided`, `added_by_member`, `approved_by_admin`,
`invite_link_allowed`, `exempt_user`, `privileged`, `own_action`,
`chat_not_whitelisted`, `route_undisclosed`.

Failures are their own events: `action_failed` (the ban was refused — usually a
missing permission), `unban_failed` (the account is out but stays banned and
cannot be re-added), `budget_exhausted`, `get_me_failed`.

Never logged: the bot token, the webhook secret, message text, usernames. What
goes out is metadata only.

## Local development

```bash
cp .env.example .env    # fill in your values; .env is gitignored
netlify dev             # serves http://localhost:8888/telegram/webhook

deno task check         # type-check the whole graph
deno task test          # unit tests
deno task fmt           # format
```

Post a recorded update at it without involving Telegram — with `DRY_RUN=true`
this exercises the whole path and calls nothing:

```bash
for f in fixtures/join_unaided.json fixtures/join_invite_link.json; do
  curl -X POST http://localhost:8888/telegram/webhook \
    -H 'Content-Type: application/json' \
    -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
    --data @"$f"
done
```

The tests cover the parts that have to be right for the bot not to remove the
wrong person: the secret comparison, the update → route mapping, every branch of
the policy, and the order of the ban and the unban behind a removal.

## Troubleshooting

**Nobody is ever removed.** Almost always `allowed_updates`: check
`getWebhookInfo` and confirm `chat_member` is in it. Second most likely, the bot
is not an admin, so Telegram withholds `chat_member` entirely. Third, `DRY_RUN`
is still `true` — look for `dry_run` lines.

**`action_failed` with "not enough rights".** The bot is an admin but without
**Ban users**.

**Invited people are being removed.** Look at the `route` on their `received`
line and the `reason` on the `enforced` one. `joined_by_self:*` means they
followed the link themselves rather than being added — set `REMOVE_SELF_JOINS`
to `false` if sharing the link is how your group invites people. `undisclosed`
means only the service message arrived and `REMOVE_UNDISCLOSED_JOINS` is on —
turn it off. `joined_by_invite_link` comes from `ALLOW_INVITE_LINK_JOINS=false`;
turn it back on.

**`401` in the Netlify logs.** The site's `TELEGRAM_WEBHOOK_SECRET` does not
match the `secret_token` given to `setWebhook`, or the site was not redeployed
after the variable changed.

## Limits worth knowing

- **Basic groups disclose almost nothing.** Invite-link information arrives only
  in supergroups. If your group has not been upgraded, every join looks
  `undisclosed`. Telegram upgrades a group to a supergroup automatically at a
  certain size, or you can trigger it by enabling chat history for new members.
- **An account removed at the moment it joins can rejoin the same way.** Nothing
  stops the same account walking in again; it will be removed again each time.
  A repeat offender is a case for a real ban, by hand.
- **The removal budget is per running instance.** Netlify runs several
  short-lived isolates, so `MAX_REMOVALS_PER_HOUR` brakes a runaway loop rather
  than capping the group's total.

## License

MIT — see [LICENSE](LICENSE).
