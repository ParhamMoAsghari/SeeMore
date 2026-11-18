'use strict';
// Telegram adapter against the offline mock Bot API (tests/mock-telegram.js). Run: node --test tests/unit
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMock } = require('../mock-telegram');

const TOKEN = '123456:TEST-token_abc';
let mock, base, Telegram, ctx;
const fakeStore = () => ({ d: { photoMsgs: [] }, save() {} });

test.before(async () => {
  mock = createMock({ token: TOKEN });
  base = await mock.listen();
  process.env.TELEGRAM_API_BASE = base;
  ({ Telegram } = require('../../lib/telegram'));
  ctx = require('../../lib/ctx');
});
test.after(() => mock.close());

const tg = () => new Telegram(TOKEN, 1001, fakeStore());

test('messenger factory: telegram is the default, bale still selectable', () => {
  const { createMessenger } = require('../../lib/messenger');
  const saved = process.env.MESSENGER; delete process.env.MESSENGER;
  try {
    assert.equal(createMessenger(null, TOKEN, 1, fakeStore()).kind, 'telegram');
    assert.equal(createMessenger('bale', TOKEN, 1, fakeStore()).kind, 'bale');
    assert.throws(() => createMessenger('icq', TOKEN, 1, fakeStore()), /unknown messenger/);
  } finally { if (saved !== undefined) process.env.MESSENGER = saved; }
});

test('getMe sets the username and the t.me deep link', async () => {
  const t = tg();
  assert.equal(t.startLink('abc'), null);
  const me = await t.getMe();
  assert.equal(me.username, 'seemore_test_bot');
  assert.equal(t.startLink('inv 1'), 'https://t.me/seemore_test_bot?start=inv%201');
});

test('sendMessage goes to the owner outside a request context, reply keyboard becomes persistent', async () => {
  const t = tg();
  const kb = { keyboard: [[{ text: 'a' }]], resize_keyboard: true };
  const m = await t.send('hello', kb);
  assert.ok(m.message_id > 0);
  const c = mock.of('sendMessage').at(-1).p;
  assert.equal(c.chat_id, 1001);
  assert.equal(c.text, 'hello');
  assert.equal(c.reply_markup.is_persistent, true);
  assert.equal(kb.is_persistent, undefined, 'caller markup is not mutated');
  await t.send('x', { inline_keyboard: [[{ text: 'b', callback_data: 'x:1' }]] });
  assert.equal(mock.of('sendMessage').at(-1).p.reply_markup.is_persistent, undefined, 'inline keyboards untouched');
});

test('per-request context targets the granted user chat', async () => {
  const t = tg();
  await ctx.run({ chat: 2002, uid: 2002 }, () => t.send('for user'));
  assert.equal(mock.of('sendMessage').at(-1).p.chat_id, 2002);
});

test('text over 4000 chars is trimmed', async () => {
  await tg().send('x'.repeat(5000));
  assert.equal(mock.of('sendMessage').at(-1).p.text.length, 4000);
});

test('editMessageText, and "message is not modified" is not an error', async () => {
  const t = tg();
  await t.editText(55, 'new text', { inline_keyboard: [] });
  const c = mock.of('editMessageText').at(-1).p;
  assert.deepEqual([c.chat_id, c.message_id, c.text], [1001, 55, 'new text']);
  assert.equal(await t.editText(55, 'same'), null);
});

test('answerCallbackQuery with text and alert', async () => {
  await tg().answer('cb-1', 'done', true);
  const c = mock.of('answerCallbackQuery').at(-1).p;
  assert.deepEqual(c, { callback_query_id: 'cb-1', text: 'done', show_alert: true });
});

test('sendPhoto: upload (multipart) and file_id; later edit() switches to editMessageCaption', async () => {
  const t = tg();
  const msg = await t.sendPhoto(Buffer.from('\xff\xd8fakejpeg'), 'caption', { inline_keyboard: [[{ text: 'go', callback_data: 'g' }]] });
  const up = mock.of('sendPhoto').at(-1);
  assert.match(up.ct, /multipart\/form-data/);
  assert.equal(up.p.chat_id, '1001');
  assert.equal(up.p.photo.filename, 'poster.jpg');
  assert.equal(JSON.parse(up.p.reply_markup).inline_keyboard[0][0].text, 'go');
  assert.equal(msg.photo.at(-1).file_id, `big_${msg.message_id}`);
  assert.ok(t.isPhoto(msg.message_id));
  await t.edit(msg.message_id, 'new caption');
  assert.equal(mock.of('editMessageCaption').at(-1).p.caption, 'new caption');
  await t.sendPhoto('big_1', 'again');
  assert.equal(mock.of('sendPhoto').at(-1).p.photo, 'big_1');
});

test('sendChatAction uses a numeric chat_id', async () => {
  await tg().action('typing');
  assert.equal(mock.of('sendChatAction').at(-1).p.chat_id, 1001);
});

test('setMyCommands drops commands Telegram would reject', async () => {
  await tg().setCommands([{ command: 'start', description: 'شروع' }, { command: '/USB', description: 'drives' }, { command: 'bad-name', description: 'x' }, { command: 'empty', description: '' }]);
  assert.deepEqual(mock.of('setMyCommands').at(-1).p.commands.map((c) => c.command), ['start', 'usb']);
});

test('getUpdates long poll returns queued updates and passes offset/allowed_updates', async () => {
  const t = tg();
  setTimeout(() => mock.pushUpdate({ update_id: 7, message: { message_id: 1, chat: { id: 1001 }, from: { id: 1001 }, text: '/start' } }), 200);
  const ups = await t.getUpdates(5);
  assert.equal(ups.length, 1);
  const c = mock.of('getUpdates').at(-1).p;
  assert.equal(c.offset, 5);
  assert.deepEqual(c.allowed_updates, ['message', 'callback_query']);
  assert.deepEqual(await t.getUpdates(8), []);
});

test('429 Too Many Requests honours retry_after and succeeds', async () => {
  mock.fail('sendMessage', 429, 'Too Many Requests: retry after 1', { retry_after: 1 });
  const t0 = Date.now();
  const m = await tg().send('after flood wait');
  assert.ok(m.message_id);
  assert.ok(Date.now() - t0 >= 800, 'waited');
});

test('4xx errors are not retried and never leak the token', async () => {
  mock.fail('sendMessage', 400, 'Bad Request: chat not found');
  const before = mock.of('sendMessage').length;
  await assert.rejects(tg().send('x'), (e) => { assert.match(e.message, /telegram sendMessage: Bad Request: chat not found/); assert.ok(!e.message.includes(TOKEN)); assert.equal(e.code, 400); return true; });
  assert.equal(mock.of('sendMessage').length, before + 1);
  const bad = new Telegram('999:wrong', 1, fakeStore());
  await assert.rejects(bad.send('x'), (e) => e.code === 401 && !e.message.includes('999:wrong'));
});

test('network failure: error marked net, token redacted', async () => {
  const saved = process.env.TELEGRAM_API_BASE; process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:9';
  const t = new Telegram(TOKEN, 1, fakeStore()); process.env.TELEGRAM_API_BASE = saved;
  await assert.rejects(t.call('getMe', {}, { tries: 1 }), (e) => e.net === true && !e.message.includes(TOKEN));
});

test('webhook mode: setWebhook with secret, receiver checks secret/path, getUpdates conflicts', async () => {
  const t = tg();
  const got = [];
  const srv = await t.startWebhook({ port: 0, host: '127.0.0.1', path: '/telegram', secret: 's3cr3t', onUpdate: (u) => got.push(u) });
  const url = `http://127.0.0.1:${srv.address().port}`;
  await t.setWebhook('https://bot.example.com/telegram', 's3cr3t');
  assert.deepEqual(mock.webhook, { url: 'https://bot.example.com/telegram', secret: 's3cr3t' });
  assert.equal((await t.getWebhookInfo()).url, 'https://bot.example.com/telegram');
  await assert.rejects(t.getUpdates(0), (e) => e.code === 409);
  const post = (path, body, secret) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body });
  assert.equal((await post('/telegram', '{"update_id":1}')).status, 401);
  assert.equal((await post('/telegram', '{"update_id":1}', 'wrong')).status, 401);
  assert.equal((await post('/other', '{"update_id":1}', 's3cr3t')).status, 404);
  assert.equal((await post('/telegram', 'not json', 's3cr3t')).status, 400);
  assert.equal((await post('/telegram', JSON.stringify({ update_id: 42, callback_query: { id: 'q', data: 'x' } }), 's3cr3t')).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((u) => u.update_id), [42]);
  assert.equal((await fetch(url + '/healthz')).status, 200);
  await t.setWebhook('http://insecure').catch((e) => assert.equal(e.code, 400));
  await t.deleteWebhook();
  assert.equal(mock.webhook.url, '');
  srv.close();
});
