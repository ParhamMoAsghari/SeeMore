'use strict';
// End-to-end: the real core process (bot.js) with MESSENGER=telegram against the offline mock Bot API.
// No Radarr/Sonarr/qBittorrent are running (their URLs point at a closed port), so only flows that do not
// need them are exercised. Run: node --test tests/integration
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('../mock-telegram');

const APP = path.join(__dirname, '..', '..');
const TOKEN = '123456:TEST-token_abc';
const OWNER = 1001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(50); } }

let portBase = 23000 + Math.floor(Math.random() * 2000) * 5;
function startBot(base, extra = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'seemore-it-'));
  for (const d of ['state', 'data', 'usb', 'ctl', 'usbctl']) fs.mkdirSync(path.join(T, d));
  const p = (portBase += 5);
  const env = {
    PATH: process.env.PATH, TZ: 'Asia/Tehran', MESSENGER: 'telegram', TELEGRAM_API_BASE: base, TELEGRAM_TOKEN: TOKEN, ALLOWED_CHAT: String(OWNER),
    DB_FILE: path.join(T, 'state/bot.db'), STATE_FILE: path.join(T, 'state/state.json'), PORT: String(p), DL_PORT: String(p + 1), API_PORT: String(p + 2),
    BACKUP_DIR: path.join(T, 'backups'), DL_CACHE: path.join(T, 'dlc'), CTL_DIR: path.join(T, 'ctl'), USB_ROOT: path.join(T, 'usb'), USB_CTL: path.join(T, 'usbctl'),
    MEDIA_ROOT: path.join(T, 'data'), RADARR_URL: 'http://127.0.0.1:9', SONARR_URL: 'http://127.0.0.1:9', QBIT_URL: 'http://127.0.0.1:9', ...extra,
  };
  const child = spawn(process.execPath, ['bot.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return { child, ports: p, log: () => out, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); }) };
}
const msg = (id, chat, text) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'u' }, text } });

test('polling mode: start-up calls, owner /start gets the persistent menu, strangers are refused, callbacks answered', async () => {
  const mock = createMock({ token: TOKEN }); const base = await mock.listen();
  const bot = startBot(base);
  try {
    assert.ok(await until(() => mock.of('setMyCommands').length), 'setMyCommands called\n' + bot.log());
    assert.ok(mock.of('getMe').length >= 1);
    assert.ok(mock.of('deleteWebhook').length >= 1, 'polling mode clears a stale webhook');
    const cmds = mock.of('setMyCommands')[0].p.commands;
    assert.ok(cmds.some((c) => c.command === 'start') && cmds.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command)));
    assert.ok(await until(() => mock.of('getUpdates').length), 'long polling started');

    mock.pushUpdate(msg(10, OWNER, '/start'));
    const menu = await until(() => mock.of('sendMessage').find((c) => c.p.chat_id === OWNER && c.p.reply_markup && c.p.reply_markup.keyboard));
    assert.ok(menu, 'owner got the main menu\n' + bot.log());
    assert.equal(menu.p.reply_markup.is_persistent, true);

    mock.pushUpdate(msg(11, 5555, '/start'));
    const refusal = await until(() => mock.of('sendMessage').find((c) => c.p.chat_id === 5555));
    assert.ok(refusal, 'stranger got an answer');
    assert.equal(refusal.p.reply_markup, undefined, 'no menu for strangers');
    assert.ok(!/کتابخانه|دانلود/.test(refusal.p.text), 'no information leaked to strangers');

    mock.pushUpdate({ update_id: 12, callback_query: { id: 'cbq-1', from: { id: OWNER }, data: 'acM', message: { message_id: menu.p.message_id || 101, chat: { id: OWNER, type: 'private' }, date: 1, text: 'x' } } });
    assert.ok(await until(() => mock.of('answerCallbackQuery').find((c) => c.p.callback_query_id === 'cbq-1')), 'callback answered\n' + bot.log());

    // offset: a re-delivered old update is ignored
    const n = mock.of('sendMessage').length;
    mock.pushUpdate(msg(9, OWNER, '/start'));
    await sleep(1500);
    assert.equal(mock.of('sendMessage').length, n, 'update below the offset not handled again');
    assert.ok(!bot.log().includes(TOKEN), 'token never logged');
  } finally { await bot.stop(); await mock.close(); }
});

test('webhook mode: setWebhook with secret, updates via the receiver, duplicates dropped', async () => {
  const mock = createMock({ token: TOKEN }); const base = await mock.listen();
  const port = 26000 + Math.floor(Math.random() * 3000);
  const bot = startBot(base, { BOT_UPDATE_MODE: 'webhook', BOT_WEBHOOK_URL: 'https://bot.example.com/tg-hook', BOT_WEBHOOK_PORT: String(port), BOT_WEBHOOK_SECRET: 'test-secret-1' });
  try {
    const sw = await until(() => mock.of('setWebhook')[0]);
    assert.ok(sw, 'setWebhook called\n' + bot.log());
    assert.equal(sw.p.url, 'https://bot.example.com/tg-hook');
    assert.equal(sw.p.secret_token, 'test-secret-1');
    assert.equal(mock.of('getUpdates').length, 0, 'no polling in webhook mode');
    const post = (u, secret = 'test-secret-1') => fetch(`http://127.0.0.1:${port}/tg-hook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(u) });
    assert.equal((await post(msg(50, OWNER, '/start'), 'nope')).status, 401);
    assert.equal((await post(msg(50, OWNER, '/start'))).status, 200);
    assert.ok(await until(() => mock.of('sendMessage').find((c) => c.p.chat_id === OWNER && c.p.reply_markup && c.p.reply_markup.keyboard)), 'menu sent\n' + bot.log());
    const n = mock.of('sendMessage').length;
    assert.equal((await post(msg(50, OWNER, '/start'))).status, 200, 're-delivery acknowledged');
    await sleep(1000);
    assert.equal(mock.of('sendMessage').length, n, 'duplicate update ignored');
  } finally { await bot.stop(); await mock.close(); }
});
