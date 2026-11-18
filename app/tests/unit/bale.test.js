'use strict';
// The optional Bale adapter speaks the same Bot API dialect; smoke-test it against the same mock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMock } = require('../mock-telegram');

test('bale adapter: base URL override, send/edit/answer, ble.ir deep link, string chat_id for chat actions', async () => {
  const mock = createMock({ token: '42:bale-token' }); const base = await mock.listen();
  process.env.BALE_API_BASE = base;
  const { Bale } = require('../../lib/bale');
  const b = new Bale('42:bale-token', 77, { d: { photoMsgs: [] }, save() {} });
  try {
    assert.equal(b.kind, 'bale');
    await b.getMe();
    assert.equal(b.startLink('c1'), 'https://ble.ir/seemore_test_bot?start=c1');
    await b.send('hi', { keyboard: [[{ text: 'a' }]], resize_keyboard: true });
    assert.equal(mock.of('sendMessage')[0].p.chat_id, 77);
    assert.equal(mock.of('sendMessage')[0].p.reply_markup.is_persistent, undefined, 'bale markup sent as given');
    assert.equal(await b.editText(5, 'same'), null);
    await b.answer('q1', 'ok');
    await b.action('typing');
    assert.equal(mock.of('sendChatAction')[0].p.chat_id, '77');
  } finally { delete process.env.BALE_API_BASE; await mock.close(); }
});
