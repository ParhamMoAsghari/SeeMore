# Bale bot (optional messenger)

[Bale](https://bale.ai) is an Iranian messenger with a Telegram-compatible Bot API. seemore's reference installation
has run on Bale since the first version; the adapter is kept as an option.

## Setup
`.env`: `MESSENGER=bale`, `BOT_TOKEN_ENV=BALE_TOKEN`, `BALE_TOKEN=<token from @botfather in Bale>`,
`ALLOWED_CHAT=<your numeric Bale id>`. Or switch in the panel: Settings → Bot → «پیام‌رسان ربات» (restarts seemore).
The update offset is stored per messenger, so switching back and forth does not lose or replay updates.

## Differences from Telegram (handled by `app/lib/bale.js`)
* API base `https://tapi.bale.ai` (override `BALE_API_BASE`), deep links `https://ble.ir/<bot>?start=<code>`.
* `sendChatAction` needs `chat_id` as a string.
* `editMessageMedia` is not implemented: paginated poster cards are deleted and re-sent.
* No `parse_mode` is used (plain text everywhere, for both messengers).
* Long polling only (webhook mode is Telegram-only in seemore).

## Tests
Live-tested on the reference installation (all bot flows, notifications, USB, imports, links; see
[../TESTS.md](../TESTS.md)). Offline smoke test against the mock Bot API: `app/tests/unit/bale.test.js`.
