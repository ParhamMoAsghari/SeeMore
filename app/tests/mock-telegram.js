'use strict';
// Minimal mock of the Telegram Bot API (https://core.telegram.org/bots/api) for offline tests.
// Records every call; answers like Telegram ({ok, result} / {ok:false, error_code, description}).
const http = require('http');

function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype || ''); if (!m) return {};
  const b = '--' + (m[1] || m[2]); const out = {};
  for (const part of buf.toString('latin1').split(b)) {
    const i = part.indexOf('\r\n\r\n'); if (i < 0) continue;
    const head = part.slice(0, i); const body = part.slice(i + 4).replace(/\r\n$/, '');
    const n = /name="([^"]+)"/.exec(head); if (!n) continue;
    const fn = /filename="([^"]*)"/.exec(head);
    out[n[1]] = fn ? { filename: fn[1], size: Buffer.byteLength(body, 'latin1') } : Buffer.from(body, 'latin1').toString('utf8');
  }
  return out;
}

function createMock({ token = '123456:TEST-token_abc', username = 'seemore_test_bot' } = {}) {
  const calls = []; const queue = []; const waiters = []; const faults = {};
  let msgId = 100; let webhook = { url: '', secret: null };
  const reply = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url.split('?')[0]);
      if (!m) return reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      if (m[1] !== token) return reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2]; const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      let p = {};
      try { p = ct.includes('multipart/form-data') ? parseMultipart(buf, ct) : (buf.length ? JSON.parse(buf.toString('utf8')) : {}); } catch { return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: can\'t parse JSON' }); }
      calls.push({ method, p, ct });
      const f = faults[method];
      if (f && f.length) { const e = f.shift(); return reply(res, e.code, { ok: false, error_code: e.code, description: e.description, parameters: e.parameters }); }
      switch (method) {
        case 'getMe': return reply(res, 200, { ok: true, result: { id: 123456, is_bot: true, first_name: 'seemore', username } });
        case 'sendMessage': {
          if (!p.chat_id) return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat_id is empty' });
          if (!p.text) return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' });
          return reply(res, 200, { ok: true, result: { message_id: ++msgId, chat: { id: Number(p.chat_id) }, date: 1, text: p.text } });
        }
        case 'sendPhoto': {
          const id = ++msgId;
          return reply(res, 200, { ok: true, result: { message_id: id, chat: { id: Number(p.chat_id) }, date: 1, caption: p.caption, photo: [{ file_id: 'small_' + id, width: 90, height: 90 }, { file_id: 'big_' + id, width: 500, height: 750 }] } });
        }
        case 'editMessageText': case 'editMessageCaption': case 'editMessageReplyMarkup':
          if (p.text === 'same' || p.caption === 'same') return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' });
          return reply(res, 200, { ok: true, result: { message_id: p.message_id, chat: { id: Number(p.chat_id) } } });
        case 'deleteMessage': case 'answerCallbackQuery': case 'sendChatAction': case 'setMyCommands': case 'deleteWebhook':
          if (method === 'deleteWebhook') webhook = { url: '', secret: null };
          return reply(res, 200, { ok: true, result: true });
        case 'setWebhook':
          if (!/^https:\/\//.test(p.url || '')) return reply(res, 400, { ok: false, error_code: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided for webhook' });
          webhook = { url: p.url, secret: p.secret_token || null };
          return reply(res, 200, { ok: true, result: true, description: 'Webhook was set' });
        case 'getWebhookInfo': return reply(res, 200, { ok: true, result: { url: webhook.url, has_custom_certificate: false, pending_update_count: 0 } });
        case 'getUpdates': {
          if (webhook.url) return reply(res, 409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
          const off = Number(p.offset || 0);
          const take = () => { const r = queue.filter((u) => u.update_id >= off); queue.splice(0, queue.length, ...queue.filter((u) => u.update_id >= off)); return r; };
          let r = take();
          if (!r.length) {
            const t = Math.min(Number(p.timeout || 0), 2) * 1000;
            await new Promise((ok) => { const w = () => ok(); waiters.push(w); setTimeout(ok, t); });
            r = take();
          }
          return reply(res, 200, { ok: true, result: r });
        }
        default: return reply(res, 404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
      }
    });
  });
  return {
    calls, token, username,
    get webhook() { return webhook; },
    pushUpdate(u) { queue.push(u); while (waiters.length) waiters.shift()(); },
    fail(method, code, description, parameters) { (faults[method] = faults[method] || []).push({ code, description, parameters }); },
    of(method) { return calls.filter((c) => c.method === method); },
    listen() { return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`))); },
    close() { srv.closeAllConnections && srv.closeAllConnections(); return new Promise((r) => srv.close(() => r())); },
  };
}

module.exports = { createMock };
if (require.main === module) {
  const m = createMock({ token: process.env.MOCK_TOKEN || '123456:TEST-token_abc' });
  m.listen().then((u) => console.log('mock telegram api on ' + u));
}
