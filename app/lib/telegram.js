'use strict';
// Telegram Bot API adapter. Same interface as bale.js (see messenger.js); Bale's API is a Telegram clone,
// so the request/retry/edit logic is inherited and only the differences live here:
//   * API base https://api.telegram.org (override with TELEGRAM_API_BASE, e.g. a local Bot API server,
//     a reverse proxy, or the mock server used by tests/telegram.test.js)
//   * reply keyboards are sent as persistent (is_persistent) so the main menu never disappears
//   * numeric chat_id for sendChatAction, command list validated to Telegram's rules
//   * deep links https://t.me/<bot>?start=<payload>
//   * webhook mode: setWebhook with secret_token + a small HTTP receiver (startWebhook)
const http = require('http');
const { Bale } = require('./bale');
const { log } = require('./util');

const MAX_BODY = 1 << 20;

class Telegram extends Bale {
  constructor(token, chat, store) {
    super(token, chat, store);
    this.kind = 'telegram';
    this.label = 'تلگرام';
    this.base = `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/bot${token}`;
  }

  startLink(payload) { return this.username ? `https://t.me/${this.username}?start=${encodeURIComponent(payload)}` : null; }

  static markup(m) {
    if (m && Array.isArray(m.keyboard) && m.is_persistent === undefined) return { ...m, is_persistent: true };
    return m;
  }

  send(text, markup, extra) { return super.send(text, Telegram.markup(markup), extra); }

  action(a = 'typing') {
    return this.call('sendChatAction', { chat_id: this.chat, action: a }, { tries: 1 }).catch(() => {});
  }

  // Telegram: command 1-32 chars [a-z0-9_], description 1-256 chars
  setCommands(commands) {
    const ok = (commands || [])
      .map((c) => ({ command: String(c.command || '').replace(/^\//, '').toLowerCase(), description: String(c.description || '').slice(0, 256) }))
      .filter((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length > 0)
      .slice(0, 100);
    return this.call('setMyCommands', { commands: ok });
  }

  // ---- webhook mode ----
  setWebhook(url, secret) {
    const p = { url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false };
    if (secret) p.secret_token = secret;
    return this.call('setWebhook', p, { tries: 5 });
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: false }, { tries: 3 }); }
  getWebhookInfo() { return this.call('getWebhookInfo', {}, { tries: 2 }); }

  // HTTP receiver for webhook updates. Answers 200 as soon as the JSON is parsed (Telegram retries on
  // non-2xx); onUpdate runs async. Requests without the right secret header or path get 401/404.
  startWebhook({ port, host = '0.0.0.0', path = '/telegram', secret, onUpdate }) {
    const srv = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (req.method === 'GET' && url === '/healthz') { res.writeHead(200); return res.end('ok'); }
      if (req.method !== 'POST' || url !== path) { res.writeHead(404); return res.end(); }
      if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) { res.writeHead(401); return res.end(); }
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (res.writableEnded) return;
        let u;
        try { u = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
        if (u && typeof u.update_id === 'number') Promise.resolve().then(() => onUpdate(u)).catch((e) => log('error', 'webhook update: ' + e.message));
      });
    });
    return new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => { srv.off('error', reject); resolve(srv); });
    });
  }
}

module.exports = { Telegram };
