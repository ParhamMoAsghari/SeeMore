'use strict';
// Messenger adapter. Everything above this layer (handlers, UIs, notify, jobs UI) only uses the
// interface below. Two adapters ship: telegram.js (default) and bale.js. Select one with the setting
// bot.messenger (env MESSENGER); the token is read from the env var named by bot.token_env.
//
// Interface (all methods target the chat of the current request context, see ctx.js; outside a
// context they target the owner):
//   owner                         numeric id of the owner chat
//   chat                          (getter) current target chat id
//   send(text, markup?, extra?)   -> { message_id }
//   sendPhoto(bufferOrFileId, caption, markup?) -> message
//   edit(id, text, markup?)       edits text or caption, whichever the message is
//   editText(id, text, markup?) / editCaption(id, caption, markup?) / editMarkup(id, markup?)
//   del(id)                       delete a message (errors ignored)
//   answer(callbackId, text?, alert?)  acknowledge a button tap
//   action(kind) / withAction(kind, fn)   typing / upload indicators
//   setCommands([{command, description}]) / getMe() -> { username }
//   getUpdates(offset)            long polling; updates use the Telegram Bot API shape
//                                 ({update_id, message | callback_query}), which Bale also uses
//   isPhoto(id) / markPhoto(id)
//   kind / label                  'telegram' | 'bale' and its Persian display name
//   startLink(payload)            deep link https://t.me/<bot>?start=<payload> (null before getMe)
// Optional (Telegram only): setWebhook(url, secret) / deleteWebhook() / getWebhookInfo() /
//   startWebhook({ port, path, secret, onUpdate }) for webhook mode (setting bot.update_mode).
// Markup is the Telegram/Bale shape: { inline_keyboard: [[{text, callback_data | url}]] } or a reply
// keyboard { keyboard: [[{text}]], resize_keyboard: true }. Callback data stays under 64 bytes.
function createMessenger(kind, token, owner, store) {
  kind = (kind || process.env.MESSENGER || 'telegram').toLowerCase();
  if (kind === 'bale') { const { Bale } = require('./bale'); return new Bale(token, owner, store); }
  if (kind === 'telegram') { const { Telegram } = require('./telegram'); return new Telegram(token, owner, store); }
  throw new Error('unknown messenger ' + kind);
}
module.exports = { createMessenger };
