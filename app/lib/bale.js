'use strict';
// Bale Bot API client with retry/backoff. The target chat comes from the request context (ctx), so
// the same code serves the owner and granted users; outside any context it falls back to the owner.
const { retry, sleep, redact, log } = require('./util');
const ctx = require('./ctx');

class BaleError extends Error {}

class Bale {
  constructor(token, chat, store) {
    this.token = token;
    this.owner = chat;
    this.store = store;
    this.kind = 'bale';
    this.label = 'بله';
    // BALE_API_BASE: optional override (e.g. a mock server in tests)
    this.base = `${(process.env.BALE_API_BASE || 'https://tapi.bale.ai').replace(/\/$/, '')}/bot${token}`;
    this.username = null;
  }

  // deep link that opens the bot with /start <payload> (invites)
  startLink(payload) { return this.username ? `https://ble.ir/${this.username}?start=${encodeURIComponent(payload)}` : null; }

  get chat() { return ctx.chat() || this.owner; }

  async call(method, params = {}, opt = {}) {
    const tries = opt.tries ?? 5;
    return retry(async () => {
      let res;
      try {
        const form = opt.form ? opt.form() : null;
        res = await fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: form ? undefined : { 'Content-Type': 'application/json' },
          body: form || JSON.stringify(params),
          signal: AbortSignal.timeout(opt.timeout || (method === 'getUpdates' ? 65000 : 30000)),
        });
      } catch (e) {
        const err = new BaleError(redact(`${this.kind} ${method}: network ${e.cause && e.cause.code || e.name}`));
        err.net = true; throw err;
      }
      const data = await res.json().catch(() => null);
      if (data && data.ok) return data.result;
      const err = new BaleError(redact(`${this.kind} ${method}: ${(data && data.description) || res.status}`));
      err.code = (data && data.error_code) || res.status;
      err.retryAfter = data && data.parameters && data.parameters.retry_after;
      throw err;
    }, { tries, base: 1200, shouldRetry: (e) => e.net || e.code === 429 || e.code >= 500 });
  }

  static notModified(e) { return e && /not modified|exactly the same/i.test(e.message || ''); }

  async send(text, markup, extra = {}) {
    const p = { chat_id: this.chat, text: String(text).slice(0, 4000), ...extra };
    if (markup) p.reply_markup = markup;
    return this.call('sendMessage', p);
  }

  // photo: Buffer or a file_id string
  async sendPhoto(photo, caption, markup) {
    const cap = String(caption).slice(0, 1020);
    let msg;
    if (typeof photo === 'string') {
      const p = { chat_id: this.chat, photo, caption: cap };
      if (markup) p.reply_markup = markup;
      msg = await this.call('sendPhoto', p, { tries: 2 });
    } else {
      msg = await this.call('sendPhoto', null, {
        tries: 3, timeout: 60000,
        form: () => {
          const f = new FormData();
          f.append('chat_id', String(this.chat));
          f.append('caption', cap);
          if (markup) f.append('reply_markup', JSON.stringify(markup));
          f.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'poster.jpg');
          return f;
        },
      });
    }
    this.markPhoto(msg.message_id);
    return msg;
  }
  markPhoto(id) { const a = this.store.d.photoMsgs; a.push(`${this.chat}:${id}`); if (a.length > 400) a.splice(0, a.length - 300); this.store.save(); }
  isPhoto(id) { const a = this.store.d.photoMsgs; return a.includes(`${this.chat}:${id}`) || (this.chat === this.owner && a.includes(id)); }

  async editText(id, text, markup) {
    const p = { chat_id: this.chat, message_id: id, text: String(text).slice(0, 4000) };
    if (markup) p.reply_markup = markup;
    try { return await this.call('editMessageText', p, { tries: 3 }); }
    catch (e) { if (Bale.notModified(e)) return null; throw e; }
  }
  async editCaption(id, caption, markup) {
    const p = { chat_id: this.chat, message_id: id, caption: String(caption).slice(0, 1020) };
    if (markup) p.reply_markup = markup;
    try { return await this.call('editMessageCaption', p, { tries: 3 }); }
    catch (e) { if (Bale.notModified(e)) return null; throw e; }
  }
  // edit whichever kind the message is (photo caption or plain text)
  edit(id, text, markup) { return this.isPhoto(id) ? this.editCaption(id, text, markup) : this.editText(id, text, markup); }
  async editMarkup(id, markup) {
    try { return await this.call('editMessageReplyMarkup', { chat_id: this.chat, message_id: id, reply_markup: markup || { inline_keyboard: [] } }, { tries: 2 }); }
    catch (e) { if (Bale.notModified(e)) return null; throw e; }
  }
  async del(id) { if (!id) return; try { await this.call('deleteMessage', { chat_id: this.chat, message_id: id }, { tries: 2 }); } catch {} }
  answer(cbId, text, alert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: cbId, text: text || '', show_alert: alert }, { tries: 2 }).catch(() => {});
  }
  action(a = 'typing') {
    // Bale only accepts chat_id as a string here
    return this.call('sendChatAction', { chat_id: String(this.chat), action: a }, { tries: 1 }).catch(() => {});
  }
  // keep a chat action alive while a slow job runs
  async withAction(a, fn) {
    this.action(a);
    const t = setInterval(() => this.action(a), 4000);
    try { return await fn(); } finally { clearInterval(t); }
  }
  setCommands(commands) { return this.call('setMyCommands', { commands }); }
  async getMe() { const me = await this.call('getMe', {}, { tries: 8 }); if (me && me.username) this.username = me.username; return me; }
  getUpdates(offset) { return this.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { tries: 1 }); }
}

module.exports = { Bale, BaleError, sleep, log };
