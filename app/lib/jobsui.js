'use strict';
// Live progress messages, pause/resume notices and final reports for every transfer job (jobs.js),
// shown in the chat of the user who started the job.
const path = require('path');
const J = require('./jobs');
const U = require('./util');
const P = require('./perms');
const ctx = require('./ctx');
const { asUser, fan } = require('./fan');
const OB = require('./outbox');

const btn = (text, cb) => ({ text, callback_data: cb });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const fa = (n) => Number(n).toLocaleString('fa-IR');
const short = (s, n = 40) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const WHY = { gone: 'حافظه جدا شد یا دیگر در دسترس نیست.', rofs: 'حافظه فقط‌خواندنی شد (معمولاً یعنی خطای فایل‌سیستم یا قطع ناگهانی).', io: 'خطای ورودی/خروجی روی حافظه رخ داد.',
  nospace: 'فضای مقصد پر شد.', restart: 'سرور یا ربات دوباره راه‌اندازی شد.', internal: 'خطای داخلی.' };
const VERB = { to_usb: 'کپی روی', import: 'انتقال به سرور از', usb_copy: 'کپی در', usb_move: 'جابه‌جایی در' };

module.exports = function createJobsUi(bale, store) {
  const d = store.d;
  d.jobMsgs = d.jobMsgs || {};
  const where = (j) => (j.kind === 'import' ? j.data.src.name : j.kind === 'to_usb' ? j.data.dst.name : j.data.src.name === j.data.dst.name ? j.data.src.name : `${j.data.src.name} ← ${j.data.dst.name}`);
  const head = (j) => `${j.kind === 'import' ? '📤' : j.kind === 'usb_move' ? '✂️' : '📥'} ${VERB[j.kind] || ''} «${where(j)}»`;

  function progText(j) {
    const total = j.data.total || 0;
    const done = j.done || 0;
    const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    if (j.status === 'queued') return `${head(j)}\n${j.title}\n\n⏸ در صف؛ بعد از کار قبلی شروع می‌شود.\n📦 ${U.bytes(total)}`;
    if (j.status === 'waiting') return `${head(j)}\n${j.title}\n\n⏸ متوقف شد: ${WHY[j.err] || j.err}\n✅ ${U.bytes(done)} از ${U.bytes(total)} سالم منتقل شده.\nبا وصل‌کردن دوباره‌ی همان حافظه، خودکار از همان‌جا ادامه پیدا می‌کند.`;
    if (j.phase === 'verify') return `${head(j)}\n${j.title}\n\n🔍 بررسی نهایی فایل‌های نوشته‌شده روی دیسک${j.cur ? `:\n${short(j.cur, 50)}` : '...'}`;
    if (j.phase === 'commit' && j.kind === 'import') return `${head(j)}\n${j.title}\n\n✅ کپی و بررسی فایل‌ها تمام شد.\n🗂 در حال افزودن به آرشیو${j.cur ? `:\n${j.cur}` : '...'}`;
    const eta = j.speed > 0 ? (total - done) / j.speed : 0;
    let t = `${head(j)}\n${j.title}\n\n${U.bar(pct, 12)} ${fa(pct)}%\n📦 ${U.bytes(done)} از ${U.bytes(total)}\n⚡ ${j.speed > 0 ? U.speed(j.speed) : '...'}${eta ? ` · ⏳ ${U.dur(eta)} مانده` : ''}`;
    if (j.cur) t += `\n🎞 فایل ${fa(j.idx || 0)} از ${fa(j.n || 0)}: ${short(j.cur, 50)}`;
    if (j.cancel) t += '\n\n⏹ در حال لغو...';
    return t;
  }
  const chatOf = (j) => j.uid || P.owner();
  async function show(j, markup) {
    const m = d.jobMsgs[j.id];
    const text = progText(j);
    return asUser(chatOf(j), async () => {
      if (m && m.mid) {
        try { await bale.editText(m.mid, text, markup); return; } catch (e) { if (!(e.code === 400 && /not found|can't be edited|deleted/i.test(e.message))) return; }
      }
      if (m && m.sending) return;
      d.jobMsgs[j.id] = { sending: true };
      try { const r = await bale.send(text, markup); d.jobMsgs[j.id] = { mid: r.message_id }; store.save(); } catch { delete d.jobMsgs[j.id]; }
    });
  }
  const live = (j) => show(j, kb([btn('⏹ لغو', `ujx:${j.id}`)]));

  function reportText(j) {
    const sm = J.summary(j.id);
    const secs = j.started && j.finished ? (j.finished - j.started) / 1000 : 0;
    const total = j.data.total || 0;
    if (j.status === 'canceled') return `⏹ ${VERB[j.kind]} «${where(j)}» لغو شد\n${j.title}\n\n${fa(sm.done.length)} فایل کامل و سالم منتقل شده؛ فایل نیمه‌کاره پاک شد. با «ادامه» از همان‌جا ادامه پیدا می‌کند.`;
    if (j.status === 'failed') return `❌ ${VERB[j.kind]} «${where(j)}» نیمه‌کاره ماند\n${j.title}\n\n${WHY[j.err] || `خطا: ${j.err}`}\n${fa(sm.done.length)} فایل کامل و سالم منتقل شده؛ با «ادامه» فایل‌های کامل دوباره کپی نمی‌شوند.`;
    let t = `✅ ${VERB[j.kind]} «${where(j)}» تمام شد\n${j.title}\n\n📦 ${fa(sm.done.length)} فایل · ${U.bytes(total)}${secs ? ` در ${U.dur(secs)}${secs > 5 ? ` (${U.speed(total / secs)})` : ''}` : ''}`;
    if (j.kind === 'import' && j.data.report) {
      const r = j.data.report;
      if (r.movies.length) t += `\n\n🎬 فیلم‌ها (${fa(r.movies.length)}):\n${r.movies.slice(0, 10).map((m) => `• ${m.title}${m.year ? ` (${m.year})` : ''}${m.subs ? ` · 💬${fa(m.subs)}` : ''}${m.added ? ' · 🆕 به Radarr اضافه شد' : ''}${m.replaced ? ' · ♻️ جایگزین شد' : ''}${m.fallback ? ' · مستقیم' : ''}\n   📂 ${short(m.path, 60)}`).join('\n')}`;
      if (r.series.length) t += `\n\n📺 سریال‌ها (${fa(r.series.length)}):\n${r.series.slice(0, 10).map((s) => `• ${s.title} · ${fa(s.eps)} قسمت از فصل ${s.seasons.map(fa).join('، ')}${s.subs ? ` · 💬${fa(s.subs)}` : ''}${s.added ? ' · 🆕 به Sonarr اضافه شد' : ''}${s.fallback ? ` · ${fa(s.fallback)} مستقیم` : ''}\n   📂 ${short(s.path, 60)}`).join('\n')}`;
      if (r.other && r.other.n) t += `\n\n🗃 سایر فایل‌ها: ${fa(r.other.n)} فایل (${U.bytes(r.other.size)})\n   📂 ${r.other.root}`;
      if (r.failed.length) t += `\n\n❌ وارد نشد:\n${r.failed.slice(0, 6).map((f) => `• ${f.title}: ${short(f.err, 60)}`).join('\n')}`;
      const sk = r.skipped || [];
      if (sk.length) t += `\n\n⏭ رد شد: ${fa(sk.length)} فایل (${sk.slice(0, 4).map((s) => short(s.name, 25)).join('، ')}${sk.length > 4 ? '، ...' : ''})`;
      if (r.movies.length || r.series.length) t += '\n\n💬 زیرنویس فارسیِ موارد بدون زیرنویس، خودکار جست‌وجو می‌شود.';
    } else {
      const fat = sm.skipped.filter((f) => f.skip === 'fat'), ex = sm.skipped.filter((f) => f.skip === 'exists');
      if (ex.length) t += `\n♻️ ${fa(ex.length)} فایل از قبل در مقصد بود.`;
      if (fat.length) t += `\n⚠️ ${fa(fat.length)} فایل به‌خاطر محدودیت ۴ گیگابایتی FAT32 کپی نشد.`;
      if (j.kind === 'to_usb' || j.kind === 'usb_copy' || j.kind === 'usb_move') t += '\n💾 همه‌چیز روی حافظه نوشته و بررسی شد.';
    }
    if (sm.failed.length) t += `\n❌ ${fa(sm.failed.length)} فایل منتقل نشد: ${sm.failed.slice(0, 3).map((f) => short(path.basename(f.dst), 30)).join('، ')}`;
    return t;
  }
  // outbox renderers: the notice is queued in the same DB transaction as the state change (jobs.js), so it is
  // delivered even if the bot was down at that moment; rendering reads the job's current state.
  function endMarkup(j) {
    const rows = [];
    const dv = J.driveOf(j.kind === 'to_usb' ? j.data.dst : j.data.src);
    if (j.status === 'canceled' || j.status === 'failed') rows.push([btn('🔁 ادامه', `ujr:${j.id}`)]);
    if (dv) rows.push([btn('📂 مشاهده‌ی حافظه', `ub:${dv.id}`), btn('⏏️ جداسازی امن', `ue:${dv.id}`)]);
    rows.push([btn('✖️ بستن', 'close')]);
    return kb(...rows);
  }
  OB.register('job_end', async ({ job }) => {
    const j = J.get(job); if (!j || !['done', 'failed', 'canceled'].includes(j.status)) return null; // stale (resumed meanwhile)
    const m = d.jobMsgs[j.id];
    return { text: reportText(j), markup: endMarkup(j), onSent: () => { delete d.jobMsgs[j.id]; store.save(); if (m && m.mid) asUser(chatOf(j), () => bale.del(m.mid)).catch(() => {}); } };
  });
  OB.register('job_waiting', async ({ job }) => {
    const j = J.get(job); if (!j || j.status !== 'waiting') return null;
    const m = d.jobMsgs[j.id];
    if (m && m.mid) { const ok = await asUser(chatOf(j), () => bale.editText(m.mid, progText(j), kb([btn('⏹ لغو', `ujx:${j.id}`)]))).then(() => true, () => false); if (ok) return null; }
    return { text: progText(j), markup: kb([btn('⏹ لغو', `ujx:${j.id}`)]), onSent: (msg) => { if (msg && msg.message_id) { d.jobMsgs[j.id] = { mid: msg.message_id }; store.save(); } } };
  });
  OB.register('job_resumed', async ({ job }) => {
    const j = J.get(job); if (!j) return null;
    return { text: `▶️ همان حافظه دوباره وصل شد (هویت تأیید شد)؛ ${VERB[j.kind]} «${where(j)}» خودکار ادامه پیدا کرد.\n${j.title}` };
  });
  OB.register('boot', async (p) => ({ text: p.text }));
  J.ev.on('progress', (j) => { if (j && (j.status === 'running' || j.status === 'queued')) live(j).catch(() => {}); });

  const mine = (j) => j && (P.isOwner(ctx.uid()) || j.uid === ctx.uid());
  async function onCallback(cb, a, p) {
    const mid = cb.message.message_id;
    const j = J.get(p[0]);
    if (!mine(j)) return bale.answer(cb.id, 'این کار پیدا نشد', true);
    if (a === 'ujx') { const ok = J.cancel(j.id); return bale.answer(cb.id, ok ? '⏹ در حال لغو...' : 'این کار دیگر فعال نیست'); }
    if (a === 'ujr') {
      const needs = [j.data.src, j.data.dst].filter((e) => e && e.type === 'usb');
      if (needs.some((e) => !J.driveOf(e))) return bale.answer(cb.id, 'حافظه‌ی این کار الان وصل نیست. وصلش کن؛ خودکار ادامه پیدا می‌کند.', true);
      const r = J.resume(j.id); await bale.answer(cb.id, r ? '🔁 دوباره در صف قرار گرفت' : 'این کار هنوز فعال است');
      if (r) bale.editMarkup(mid, null).catch(() => {});
      return;
    }
    if (a === 'ujs') { await bale.answer(cb.id); const m = d.jobMsgs[j.id]; if (m && m.mid) bale.del(m.mid); delete d.jobMsgs[j.id]; return live(J.get(j.id)); }
    return bale.answer(cb.id);
  }
  // after a crash/power cut: one summary for the owner
  async function bootNotice({ resumed, waiting }) {
    if (!resumed.length && !waiting.length) return;
    const t = ['🔌 سرور یا ربات دوباره راه‌اندازی شد.'];
    if (resumed.length) t.push(`▶️ ${fa(resumed.length)} کار انتقال خودکار ادامه پیدا کرد: ${resumed.map((j) => short(j.title, 30)).join('، ')}`);
    if (waiting.length) t.push(`⏸ ${fa(waiting.length)} کار منتظر وصل‌شدن دوباره‌ی حافظه است: ${waiting.map((j) => short(j.title, 30)).join('، ')}`);
    OB.enqueue(P.owner(), 'boot', { text: t.join('\n') }, `boot:${Date.now()}`);
  }
  return { onCallback, progText, bootNotice, live };
};
