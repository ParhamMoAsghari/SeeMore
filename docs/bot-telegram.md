# Telegram bot (default messenger)

Adapter: `app/lib/telegram.js` (extends the shared Bot API client in `bale.js`; interface in `messenger.js`).
Everything above the adapter — menus, wizards, progress messages, notifications — is messenger-independent.

## Setup
1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Find your numeric user id (e.g. send `/start` to @userinfobot).
3. In `.env`: `MESSENGER=telegram`, `BOT_TOKEN_ENV=TELEGRAM_TOKEN`, `TELEGRAM_TOKEN=<token>`, `ALLOWED_CHAT=<your id>`.
4. `docker compose up -d seemore`, then send `/start` to your bot. The command list is registered automatically
   (`setMyCommands`).

## Features
* Persistent main menu (reply keyboard with `is_persistent`), inline buttons for every flow, callback data < 64 bytes.
* Poster cards (`sendPhoto` upload, later reuse by `file_id`), edits instead of new messages (`editMessageText` /
  `editMessageCaption`; "message is not modified" is ignored), typing/upload indicators.
* Live progress messages edited every `jobs.progress_every_s` seconds with Telegram's rate limits respected:
  429 answers are retried after `retry_after`, 5xx/network errors with backoff, 4xx are not retried.
* Invites: `https://t.me/<bot>?start=<code>`.
* The token never appears in logs or errors (`bot***` redaction).

## Receiving updates
| `bot.update_mode` | how | when to use |
|---|---|---|
| `polling` (default) | `getUpdates` long poll (25 s); a stale webhook is deleted at start | behind NAT, no public HTTPS needed |
| `webhook` | `setWebhook(url, secret_token)`; seemore listens on `bot.webhook_port` (default 3003) | public HTTPS endpoint, lower latency |

Webhook mode:
* `BOT_WEBHOOK_URL=https://bot.example.com/telegram` (the path is the receiver path), `BOT_WEBHOOK_PORT=3003`,
  `BOT_WEBHOOK_SECRET=<random>` (checked in `X-Telegram-Bot-Api-Secret-Token`; derived from the token if empty).
* Proxy the URL to the container, e.g. in `config/Caddyfile`:
  ```
  bot.example.com {
  	reverse_proxy /telegram seemore:3003
  }
  ```
* Wrong secret → 401, wrong path → 404, bad JSON → 400; valid updates are acknowledged with 200 immediately and
  processed asynchronously. Updates below the stored offset (re-deliveries) are ignored, so a re-sent update is
  handled once. Health is checked with `getWebhookInfo` every minute.
* Switching back to polling deletes the webhook automatically.

Changing `bot.messenger`, `bot.token_env`, `bot.update_mode` or `bot.webhook_*` in the panel restarts seemore
(change class `reload`).

## Networks where Telegram is filtered
Set `TELEGRAM_API_BASE` to a reachable Bot API endpoint: a self-hosted
[telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server or a reverse proxy you control. Recent Node.js
releases can route `fetch` through `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set (check the Node version of your
image, `NODE_IMAGE`). Or use the Bale adapter
([bot-bale.md](bot-bale.md)).

## Tests
`make test-unit test-integration` (or `cd app && node --test 'tests/unit/*.test.js' 'tests/integration/*.test.js'`)
runs the adapter and the whole core process against an offline mock of the Bot API (`app/tests/mock-telegram.js`):
send/edit/answer/photo/actions/commands, long polling, 429 handling, token redaction, webhook secret/path checks,
owner menu, stranger refusal, callback answers, duplicate updates. Results in [../TESTS.md](../TESTS.md).
**Not yet tested against the real api.telegram.org** — see the known limitations in the release notes.
