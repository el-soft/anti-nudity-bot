# nudity-detector-bot

A Telegram bot on a Netlify Edge Function that **logs every update it receives**.
One JSON line per event: what kind of update it was, which chat it came from, and
which account is behind it.

It sends nothing, downloads nothing and changes nothing in any chat. The
detection and enforcement logic that gave the repo its name has been removed; it
is in the git history if it is wanted back.

A line looks like this:

```json
{"level":"info","ts":"2026-09-11T10:12:03.221Z","event":"received","update_id":100237,
 "message_type":"message.photo","chat_id":-1001234567890,"user_id":777888999,
 "message_id":4821,"chat_type":"supergroup"}
```

Never logged: the webhook secret, message text, usernames, file contents. What
goes out is metadata only.

## Usage

### 1. Create your Telegram bot

Message [@BotFather](https://t.me/BotFather):

- `/newbot` → pick a name and a username.
- `/setprivacy` → choose your bot → **Disable**.
  Without this the bot only sees messages that mention it, so most of the group's
  traffic never reaches the log.

The token is not needed: the bot never calls the Bot API.

### 2. Deploy to Netlify

**Add new site → Import an existing project** → pick your fork → deploy. Build
settings come from `netlify.toml`. Your webhook endpoint is:

```
https://<your-site>.netlify.app/telegram/webhook
```

### 3. Set environment variables

**Site configuration → Environment variables**, or from the CLI:

```bash
netlify env:set TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
```

Then **redeploy** — variables are read at startup.

### 4. Connect the webhook

Most update types are **not sent by default** — you have to ask for them by name.
This is the most common reason a bot appears to see nothing. `allowed_updates`
below asks for everything this bot can name:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
        "url": "https://<your-site>.netlify.app/telegram/webhook",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": [
          "message", "edited_message", "channel_post", "edited_channel_post",
          "message_reaction", "message_reaction_count",
          "chat_member", "my_chat_member", "chat_join_request",
          "callback_query", "poll", "poll_answer",
          "chat_boost", "removed_chat_boost"
        ]
      }'
```

Check it worked: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`

`chat_member` is the one to keep an eye on: without it, joins and departures are
only visible through the service message in the chat, which Telegram stops
sending in large groups.

### 5. Add the bot to your group

Plain membership is enough to log messages. Promote it to admin only if you want
`chat_member` updates for every join, departure and ban.

Read the lines under **Logs → Edge Functions** on your Netlify site.

## Environment variables

| Variable                  | Required | Default | Meaning                                          |
| ------------------------- | -------- | ------- | ------------------------------------------------ |
| `TELEGRAM_WEBHOOK_SECRET` | yes      | —       | Must equal the `secret_token` given to setWebhook |
| `LOG_LEVEL`               | no       | `info`  | `debug`, `info`, `warn` or `error`                |

A missing or invalid value is fatal: the function then answers 200 and logs a
`config_error` line per problem instead of processing updates. 200 rather than
500, because a non-2xx makes Telegram retry the same update forever.

## What each line reports

| Field          | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `message_type` | What happened — see below                                              |
| `chat_id`      | The chat; absent for updates that carry none (inline queries, polls)   |
| `user_id`      | The account behind it; absent for channel posts and anonymous admins   |
| `message_id`   | Present when the update is about a specific message                    |
| `chat_type`    | `private`, `group`, `supergroup` or `channel`, when Telegram sends it   |
| `is_bot`       | Present and `true` only for bot accounts                               |
| `detail`       | Extra context: the membership transition, `reply`, `forward=<type>`, …  |

`message_type` is one of:

- **Messages** — `message.<kind>`, where `<kind>` is `text`, `photo`, `sticker`,
  `video`, `animation`, `voice`, `audio`, `document`, `contact`, `location`,
  `poll`, `dice`, `story`, `game`, `invoice`, … or `other`. Edits and channel
  posts use the same suffix: `edited_message.text`, `channel_post.photo`.
- **Membership** — `joined`, `left`, `banned`, `role_changed`,
  `membership_changed`, `join_request`. A `chat_member` update and the in-chat
  service message both produce these; `detail` says which.
- **Reactions** — `reaction`, `reaction_count`.
- **Chat service events** — `message_pinned`, `chat_title_changed`,
  `chat_photo_changed`, `video_chat_started`, `forum_topic_created`, …
- **Interaction** — `callback_query`, `inline_query`, `chosen_inline_result`,
  `poll_answer`, `poll_state`.
- **Other** — `chat_boost`, `business_message`, `paid_media_purchased`, and
  `unknown` for an update type this bot does not name yet.

One update can produce several lines: a join notice naming three accounts is
three `joined` lines, because "who joined" is the interesting column.

## Finding your chat ID

Add the bot to the group and post anything; the `chat_id` is in the log line.

## Local development

```bash
cp .env.example .env    # fill in your values; .env is gitignored
netlify dev             # serves http://localhost:8888/telegram/webhook

deno task check         # type-check the whole graph
deno task test          # unit tests
deno task fmt           # format
```

Post a recorded update at it without involving Telegram:

```bash
curl -X POST http://localhost:8888/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  --data @fixtures/message_photo.json
```

The tests cover the two things that have to be right: the secret comparison that
keeps strangers out, and the update → `{message_type, chat_id, user_id}` mapping.

## Troubleshooting

**Nothing is logged.** Check `getWebhookInfo` for `last_error_message`. If the
URL and secret are right, the usual cause is `allowed_updates` — it replaces the
list on every `setWebhook` call, so a later call with a short list silently turns
the rest off.

**Only messages that mention the bot appear.** Privacy mode is still on; disable
it in BotFather and re-add the bot to the group.

**`401` in the Netlify logs.** The `TELEGRAM_WEBHOOK_SECRET` on the site does not
match the `secret_token` given to `setWebhook`, or the site was not redeployed
after the variable changed.

## License

MIT — see [LICENSE](LICENSE).
