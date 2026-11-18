'use strict';
// Plug / unplug health messages (bot + panel data), against loop-image drives mounted by the real host helper.
// Driven by tests/server/healthmsg.sh through handshake files in /state. Labels SMPROTH* only; own DB, no Bale traffic.
//   clean drive  -> minimal connect notice, no health line; safe eject -> no unplug message
//   dirty drive  -> one short line «⚠️ این فلش قبلاً بدون جداسازی امن جدا شده؛ بعداً چک کن.», no repair push
//   pulled while mounted -> one short «بدون جداسازی امن جدا شد؛ بعداً چکش کن.»; unmounted before pull -> nothing
const fs = require('fs');
const DB = require('../lib/db');
const P = require('../lib/perms');
DB.open(process.env.DB_FILE || '/state/h.db');
const OWNER = Number(process.env.BALE_CHAT_ID || 1484089453);
P.setOwner(OWNER);
require('../lib/settings').start();
const S = require('../lib/usb');
const ctx = require('../lib/ctx');
let pass = 0, fail = 0;
const rec = (n, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? ' — ' + info : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (f, s = 120) => { for (let i = 0; i < s * 2; i++) { if (fs.existsSync('/state/' + f)) return true; await sleep(500); } throw new Error('timeout waiting ' + f); };
const touch = (f) => fs.writeFileSync('/state/' + f, '1');
const drv = (label) => S.readDrives().find((d) => d.label === label);
const DIRTY = '⚠️ این فلش قبلاً بدون جداسازی امن جدا شده؛ بعداً چک کن.';
const HEALTHY = /سالم|🩺|جداسازی امن جدا|چک کن|تعمیر|Check disk|خطا/;

(async () => {
  // unit: labels
  rec('healthNote clean/repaired/skipped -> nothing', ['clean', 'repaired', 'skipped', 'timeout', '', undefined].every((r) => S.healthNote(r) === ''));
  rec('healthNote dirty -> one short line', S.healthNote('dirty') === DIRTY);
  rec('healthNote errors -> short error line', /^❗ .*بعداً/.test(S.healthNote('errors(2)')) && !/\n/.test(S.healthNote('errors(2)')));

  const sent = [];
  const bale = { answer: async (id, t, alert) => sent.push({ answer: t || '', alert }), send: async (t, kb) => { sent.push({ send: t, kb }); return { message_id: 1 }; }, editText: async () => {}, action: () => {}, withAction: async (a, fn) => fn() };
  const store = { d: { usbKnown: {} }, save() {} };
  const present = async (k, mid, text, kb) => { sent.push({ present: text, kb }); return { message_id: 1 }; };
  const ui = require('../lib/usbui')(bale, store, present, {});
  const waitSend = async (pred, s = 20) => { for (let i = 0; i < s * 2; i++) { const m = sent.find((x) => x.send && pred(x.send)); if (m) return m; await sleep(500); } return null; };
  const unplugMsgs = () => sent.filter((x) => x.send && !/وصل شد/.test(x.send) && /جدا شد/.test(x.send));

  await ctx.run({ chat: OWNER, uid: OWNER }, async () => {
    ui.startWatcher(); await sleep(4000); touch('ready');

    // 1) clean drive
    await waitFile('p1');
    let m = await waitSend((t) => t.includes('حافظه‌ی جدید وصل شد') && t.includes('SMPROTH1'));
    rec('clean: connect notice sent', !!m);
    if (m) {
      rec('clean: no health / unsafe-eject / repair line in the notice', !HEALTHY.test(m.send), m.send.replace(/\n/g, ' | '));
      rec('clean: notice still shows 🔒 محافظت‌شده + «🔒 محافظت و سلامت» button', /🔒 محافظت‌شده/.test(m.send) && JSON.stringify(m.kb).includes('محافظت و سلامت'));
    }
    let x = drv('SMPROTH1');
    rec('clean: fsck=clean', x && x.fsck === 'clean', x && x.fsck);
    await ui.showDrives(1); let t = sent[sent.length - 1];
    rec('clean: drive list has no health line', !HEALTHY.test(t.present), t.present.replace(/\n/g, ' | '));
    // safe eject (same path as the panel button), then the device goes away
    const n0 = unplugMsgs().length;
    const r = await S.eject(x.id); rec('clean: safe eject ok', r.ok, r.msg);
    await sleep(7000); touch('e1'); await waitFile('g1'); await sleep(7000);
    rec('clean: NO unplug message after a safe eject', unplugMsgs().length === n0, unplugMsgs().map((s) => s.send).join(' / '));

    // 2) dirty drive (pulled out unsafely last time)
    await waitFile('p2');
    m = await waitSend((t2) => t2.includes('حافظه‌ی جدید وصل شد') && t2.includes('SMPROTH2'));
    rec('dirty: connect notice sent', !!m);
    if (m) {
      const extra = m.send.split('\n').filter((l) => /جداسازی|چک|تعمیر|سلامت|خطا|Check/.test(l));
      rec('dirty: exactly one short line «…بدون جداسازی امن جدا شده؛ بعداً چک کن.»', extra.length === 1 && extra[0] === DIRTY, extra.join(' / '));
      rec('dirty: no repair prompt/button in the notice', !/تعمیر/.test(m.send) && !/تعمیر|uMr/.test(JSON.stringify(m.kb)));
      rec('dirty: «🔒 محافظت و سلامت» button kept', JSON.stringify(m.kb).includes('محافظت و سلامت'));
    }
    x = drv('SMPROTH2');
    rec('dirty: fsck=dirty (check only), still protected ro', x && x.fsck === 'dirty' && x.fsckKind === 'check' && x.protected && x.ro, x && `${x.fsck} ${x.fsckKind} ${x.mode}`);
    await ui.showDrives(1); t = sent[sent.length - 1];
    rec('dirty: drive list shows only the short label', t.present.includes('⚠️ قبلاً بدون جداسازی امن جدا شده') && !/Check disk|تعمیر/.test(t.present), t.present.replace(/\n/g, ' | '));
    const ck = await core().call(OWNER, 'usb.check', { drive: x.id });
    rec('dirty: manual check (API/panel) still check-only, short label', ck.ok && ck.result === 'dirty' && !/Check disk/.test(ck.label || ''), `${ck.result} ${ck.label}`);
    const n1 = unplugMsgs().length;
    touch('n2');
    // 3) pulled out while still mounted
    await waitFile('u2');
    const um = await waitSend((t2) => /^⚠️ «.*» بدون جداسازی امن جدا شد؛/.test(t2), 20);
    rec('unsafe pull: one short unplug line', !!um && um.send === '⚠️ «SMPROTH2» بدون جداسازی امن جدا شد؛ بعداً چکش کن.', um ? um.send : 'none');

    // 4) unmounted cleanly before pulling (outside the bot) -> nothing
    await waitFile('p3');
    await waitSend((t2) => t2.includes('حافظه‌ی جدید وصل شد') && t2.includes('SMPROTH1') && sent.filter((s) => s.send && s.send.includes('SMPROTH1') && s.send.includes('وصل شد')).length >= 2);
    const n3 = unplugMsgs().length; touch('n3');
    await waitFile('u3'); await sleep(8000);
    rec('clean unmount then pull: NO unplug message', unplugMsgs().length === n3, unplugMsgs().slice(n3).map((s) => s.send).join(' / '));
  });
  console.log(`RESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed:', e.stack); process.exit(1); });
function core() { return require('../lib/core'); }
