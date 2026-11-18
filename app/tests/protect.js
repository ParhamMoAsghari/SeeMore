'use strict';
// Write-protection tests at the API / core / bot-UI layer, against loop-image drives mounted by the real
// host helper (label SMPROT*). Run in a throwaway container with its own DB (no Bale traffic):
//   DB_FILE=/state/t.db node tests/protect.js <protectedLabel>
// Never touches any drive whose label does not start with SMPROT.
const fs = require('fs');
const path = require('path');
const DB = require('../lib/db');
const P = require('../lib/perms');
DB.open(process.env.DB_FILE || '/state/t.db');
const OWNER = Number(process.env.BALE_CHAT_ID || 1484089453);
P.setOwner(OWNER);
require('../lib/settings').start();
const S = require('../lib/usb');
const J = require('../lib/jobs');
const core = require('../lib/core');
const ctx = require('../lib/ctx');
const label = process.argv[2] || 'SMPROT3';
let pass = 0, fail = 0;
const rec = (n, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? ' — ' + info : ''}`); };
const drv = () => { const x = S.readDrives().find((d) => d.label === label); if (!x || !/^SMPROT/.test(x.label)) throw new Error('no test drive ' + label); return x; };
async function refused(name, fn) {
  try { await fn(); rec(name, false, 'not refused'); }
  catch (e) { rec(name, (e.code === 'EPROTECTED' || e.status === 403) && /محافظت|فقط‌خواندنی/.test(e.message), `${e.status || ''} ${String(e.message).slice(0, 60)}`); }
}
const call = (m, p) => core.call(OWNER, m, p);
(async () => {
  let x = drv();
  rec('drive visible as protected + ro', x.mode === 'protected' && x.ro && x.mountRo, `${x.mode} ro=${x.ro} mountRo=${x.mountRo}`);
  const before = fs.readFileSync('/proc/self/mountinfo', 'utf8').includes(x.mount);
  // allowed: browse + metadata
  const ents = await call('usb.list', { drive: x.id, rel: '' }); rec('browse allowed', Array.isArray(ents) && ents.length > 0, ents.map((e) => e.name).join(','));
  const m = await call('usb.inspect', { drive: x.id, rel: 'note.txt' }); rec('metadata allowed', !!m, m && (m.kind || m.mime || ''));
  // refused writes (core = API = panel)
  await refused('mkdir refused', () => call('usb.mkdir', { drive: x.id, rel: '', name: 'newdir' }));
  await refused('rename refused', () => call('usb.rename', { drive: x.id, rel: 'note.txt', name: 'n2.txt' }));
  await refused('move (same drive) refused', () => call('usb.move', { drive: x.id, rel: 'note.txt', dest: 'Movies' }));
  await refused('delete refused', () => call('usb.delete', { drive: x.id, rel: 'note.txt' }));
  await refused('transfer/move refused', () => call('usb.transfer', { from: x.id, to: x.id, rel: 'note.txt', destRel: 'Movies', op: 'move' }));
  await refused('copy-to-drive plan refused', () => call('usb.copyPlan', { drive: x.id, sel: {} }));
  await refused('copy-to-drive refused', () => call('usb.copy', { drive: x.id, files: [] }));
  await refused('repair refused on protected', () => call('usb.repair', { drive: x.id, confirm: true }));
  // job-engine guard: a to_usb job forced onto the protected drive never writes (waits for the device instead)
  try { S.assertWritablePath(path.join(x.mount, 'x.part')); rec('job write guard', false); } catch (e) { rec('job write guard refuses paths on protected drive', e.code === 'EPROTECTED'); }
  // health check (read-only)
  const ck = await call('usb.check', { drive: x.id }); rec('check-only health check', ck.ok && !!ck.result, `${ck.result} (${ck.label})`);
  // mode switch needs confirm + admin
  try { await call('usb.mode', { drive: x.id, mode: 'writable' }); rec('mode without confirm refused', false); } catch (e) { rec('mode without confirm refused', e.status === 428); }
  try { await core.call(999999, 'usb.mode', { drive: x.id, mode: 'writable', confirm: true }); rec('mode by non-owner refused', false); } catch (e) { rec('mode by non-owner refused', e.status === 403); }
  // bot UI: drive list / menu shows the mode; write buttons hidden; repair alert
  const sent = [];
  const bale = { answer: async (id, t, alert) => sent.push({ answer: t || '', alert }), send: async (t, kb) => { sent.push({ send: t, kb }); return { message_id: 1 }; }, editText: async () => {}, action: () => {}, withAction: async (a, fn) => fn() };
  const store = { d: {}, save() {} };
  const present = async (k, mid, text, kb) => { sent.push({ present: text, kb }); return { message_id: 1 }; };
  const ui = require('../lib/usbui')(bale, store, present, {});
  await ctx.run({ chat: OWNER, uid: OWNER }, async () => {
    await ui.showDrives(1);
    const t = sent[sent.length - 1];
    rec('bot drive list shows 🔒 محافظت‌شده', /محافظت‌شده \(فقط‌خواندنی\)/.test(t.present) && JSON.stringify(t.kb).includes(`uM:${x.id}`));
    await ui.onCallback({ id: 'c', message: { message_id: 1 } }, 'uM', [x.id]);
    const mm = sent[sent.length - 1];
    rec('bot drive menu offers «✏️ اجازهٔ نوشتن» + «🩺 بررسی سلامت», no repair', JSON.stringify(mm.kb).includes('اجازهٔ نوشتن') && JSON.stringify(mm.kb).includes('بررسی سلامت') && !JSON.stringify(mm.kb).includes('تعمیر'));
    await ui.onCallback({ id: 'c', message: { message_id: 1 } }, 'uMR', [x.id]);
    const al = sent[sent.length - 1];
    rec('bot repair on protected -> alert refused', al.alert && /محافظت/.test(al.answer));
    await ui.browse(1, x.id, '', 0);
    const br = sent[sent.length - 1];
    const kbs = JSON.stringify(br.kb);
    rec('bot browse hides write buttons', !/پوشه‌ی جدید|کپی از کتابخانه به اینجا/.test(kbs) && /انتقال به سرور/.test(kbs));
    // plug notice (the watcher sends it for a drive mounted after start)
    store.d.usbKnown = {}; ui.startWatcher();
    await new Promise((r) => setTimeout(r, 5500));
    const nt = sent.find((s) => s.send && s.send.includes('حافظه‌ی جدید وصل شد') && s.send.includes(label));
    rec('bot connect notice shows the mode', !!nt && /🔒 محافظت‌شده/.test(nt.send), nt ? nt.send.split('\n').slice(2, 4).join(' | ') : 'no notice');
  });
  if (process.argv.includes('toggle')) {
    const r1 = await call('usb.mode', { drive: x.id, mode: 'writable', confirm: true }); x = drv();
    rec('owner -> writable (confirmed): rw', r1.ok && !x.ro && S.writable(x), `ro=${x.ro} mountRo=${x.mountRo}`);
    const rel = await call('usb.mkdir', { drive: x.id, rel: '', name: 'made-when-writable' }); rec('mkdir works when writable', rel === 'made-when-writable');
    await call('usb.delete', { drive: x.id, rel: 'made-when-writable' });
    const r2 = await call('usb.mode', { drive: x.id, mode: 'protected', confirm: true }); x = drv();
    rec('owner -> protected: synced + ro', r2.ok && x.ro && x.mountRo && x.protected);
    await refused('mkdir refused again after re-protect', () => call('usb.mkdir', { drive: x.id, rel: '', name: 'again' }));
  }
  // import from the protected drive (non-media files only -> /data/usb-imports), source must stay untouched
  if (process.argv.includes('import')) {
    x = drv();
    const sc = await call('import.scan', { drive: x.id, rel: '' });
    const job = await call('import.start', { scanId: sc.scanId, sel: { movies: {}, series: {}, other: true, unknownAsOther: true } });
    J.boot();
    let j; for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); j = J.get(job.id); if (['done', 'failed', 'canceled'].includes(j.status)) break; }
    rec('import from protected drive completed', j.status === 'done', `${j.status} ${j.err || ''}`);
    const fl = J.files(job.id); console.log('imported:', fl.map((f) => `${f.status} ${f.dst}`).join(' ; '));
    fs.writeFileSync('/state/imported.json', JSON.stringify(fl.map((f) => f.dst)));
  }
  console.log(`RESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.stack); process.exit(2); });
