'use strict';
// «📤 انتقال به سرور»: scan a drive (or folder), review what was detected, correct matches, confirm.
const path = require('path');
const fs = require('fs');
const S = require('./usb');
const J = require('./jobs');
const I = require('./importer');
const U = require('./util');
const P = require('./perms');
const ctx = require('./ctx');

const btn = (text, cb) => ({ text, callback_data: cb });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const fa = (n) => Number(n).toLocaleString('fa-IR');
const short = (s, n = 30) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const PAGE = 6;

module.exports = function createImportUi(bale, store, present) {
  const d = store.d;
  const W = () => d.impw;
  const dfData = () => { const s = fs.statfsSync('/data'); return s.bavail * s.bsize; };
  const itemSize = (cat, it, s) => {
    if (cat === 'm') return it.dup && !s.replace ? 0 : it.size;
    return it.eps.filter((e) => !e.dup || s.replace).reduce((a, e) => a + e.size + (e.subs || []).reduce((x, y) => x + y.size, 0), 0);
  };
  function totals(w) {
    const r = w.res; let n = 0, size = 0;
    r.movies.forEach((m, i) => { const s = w.sel.movies[i]; if (s && s.on) { const z = itemSize('m', m, s); if (z) { n++; size += z; } } });
    r.series.forEach((x, i) => { const s = w.sel.series[i]; if (s && s.on) { const z = itemSize('s', x, s); if (z) { n++; size += z; } } });
    if (w.sel.other) size += r.other.reduce((a, o) => a + o.size, 0);
    if (w.sel.unknownAsOther) size += r.unknown.reduce((a, u) => a + u.size, 0);
    return { n, size };
  }

  async function start(mid, driveId, rel) {
    const x = S.getDrive(driveId);
    if (x) { await S.ensureMarker(x).catch(() => {}); x.marker = S.readMarker(x.mount); }
    if (!x) return present('usb', mid, 'این حافظه دیگر وصل نیست.', kb([btn('↩️ حافظه‌ها', 'ud')]));
    const steps = { scan: '۱/۵ پیمایش فایل‌ها', classify: '۲/۵ دسته‌بندی (ویدیو، زیرنویس، نمونه، سایر)', identify: '۳/۵ شناسایی فنی ویدیوها (مدت، کیفیت)', match: '۴/۵ تطبیق با Radarr و Sonarr (شناسه‌های TMDb/TVDb)', dedupe: '۵/۵ بررسی تکراری‌ها' };
    const m = await present('usb', mid, `🔎 بررسی «${x.name}${rel ? '/' + rel : ''}»...\n${steps.walk}`, null);
    const msgId = m && m.message_id;
    let last = 0;
    const res = await bale.withAction('typing', () => I.scan(x, rel, (st, n) => {
      if (Date.now() - last < 1500 || !msgId) return; last = Date.now();
      bale.editText(msgId, `🔎 بررسی «${x.name}${rel ? '/' + rel : ''}»...\n${steps[st] || st}${n ? ` (${fa(n)})` : ''}`).catch(() => {});
    }));
    const sel = { movies: {}, series: {}, other: true, unknownAsOther: true };
    res.movies.forEach((it, i) => { sel.movies[i] = { on: !it.needsConfirm, replace: false }; });
    res.series.forEach((it, i) => { sel.series[i] = { on: !it.needsConfirm, replace: false }; });
    d.impw = { res, sel, page: 0, t: Date.now() };
    store.save();
    P.audit(ctx.uid(), 'usb_import', 'scan', `${x.name}/${rel || ''} ${res.stats.files}`);
    return review(msgId);
  }

  function review(mid) {
    const w = W(); if (!w) return present('usb', mid, 'این بررسی منقضی شده؛ دوباره «انتقال به سرور» را بزن.', kb([btn('↩️ حافظه‌ها', 'ud')]));
    const r = w.res;
    const t = totals(w);
    const free = dfData();
    const L = [`📤 انتقال از «${r.drive.name}${r.root ? '/' + r.root : ''}» به سرور`, ''];
    L.push(`🔍 ${fa(r.stats.files)} فایل بررسی شد: ${fa(r.stats.videos)} ویدیو، ${fa(r.stats.subs)} زیرنویس، ${fa(r.stats.other)} فایل دیگر`);
    if (r.movies.length) L.push('', `🎬 فیلم‌ها (${fa(r.movies.length)}):`, ...r.movies.slice(0, 12).map((m, i) => `${w.sel.movies[i].on ? '✅' : '⬜'} ${m.match.title}${m.match.year ? ` (${m.match.year})` : ''} · ${U.bytes(m.file.size)}${(m.file.subs || []).length ? ` · 💬${fa(m.file.subs.length)}` : ''}${m.match.id ? '' : ' · 🆕'}${m.needsConfirm ? ' · ⚠️ نیاز به تأیید' : ''}${m.dup ? ` · ♻️ موجود (${U.bytes(m.dup.size)})${w.sel.movies[i].replace ? ' → جایگزین' : ' → رد'}` : ''}`));
    if (r.series.length) L.push('', `📺 سریال‌ها (${fa(r.series.length)}):`, ...r.series.slice(0, 12).map((s, i) => {
      const seas = [...new Set(s.eps.map((e) => e.s))];
      return `${w.sel.series[i].on ? '✅' : '⬜'} ${s.match.title} · ${fa(s.eps.length)} قسمت از فصل ${seas.map(fa).join('، ')}${s.match.id ? '' : ' · 🆕'}${s.needsConfirm ? ' · ⚠️ نیاز به تأیید' : ''}${s.dups ? ` · ♻️ ${fa(s.dups)} قسمت موجود${w.sel.series[i].replace ? ' → جایگزین' : ' → رد'}` : ''}`;
    }));
    const nc = [...r.movies, ...r.series].filter((x) => x.needsConfirm).length;
    if (nc) L.push('', `⚠️ ${fa(nc)} مورد با اطمینان کم تشخیص داده شد و فعلاً انتخاب نشده. در «انتخاب و اصلاح موارد» با ✏️ تطبیق درست را تأیید کن یا با ✅ همین را بپذیر.`);
    if (r.unknown.length) L.push('', `❓ ناشناخته (${fa(r.unknown.length)}): ${r.unknown.slice(0, 5).map((u) => short(u.title || (u.file || u.eps[0]).name, 25)).join('، ')}${w.sel.unknownAsOther ? '\n   → به پوشه‌ی «سایر» می‌روند (با ✏️ می‌توانی تطبیقشان بدهی)' : '\n   → منتقل نمی‌شوند'}`);
    if (r.other.length) L.push('', `🗃 سایر فایل‌ها: ${fa(r.other.length)} فایل (${U.bytes(r.other.reduce((a, o) => a + o.size, 0))})${w.sel.other ? '' : ' → منتقل نمی‌شوند'}`);
    if (w.sel.other || w.sel.unknownAsOther) L.push(`   📂 ${path.join(I.IMPORT_ROOT, S.cleanName(r.drive.label || r.drive.name, 'vfat').replace(/\s+/g, '_'), U.ymd(Date.now()))}`);
    const smp = r.skipped.filter((s) => s.why === 'sample').length, dd = r.skipped.filter((s) => s.why === 'dupdrive').length;
    if (smp || dd) L.push('', `⏭ رد می‌شوند: ${smp ? `${fa(smp)} نمونه (sample)` : ''}${smp && dd ? '، ' : ''}${dd ? `${fa(dd)} نسخه‌ی تکراری روی خود حافظه (بزرگ‌ترین نگه داشته شد)` : ''}`);
    L.push('', `📦 حجم انتقال: ${U.bytes(t.size)} · 💽 فضای آزاد سرور: ${U.bytes(free)}`);
    const rows = [[btn('📋 انتخاب و اصلاح موارد', 'uiL:0')]];
    rows.push([btn(`${w.sel.other ? '✅' : '⬜'} سایر فایل‌ها`, 'uiTo'), btn(`${w.sel.unknownAsOther ? '✅' : '⬜'} ناشناخته‌ها به «سایر»`, 'uiTu')]);
    if (t.size + 1073741824 > free) L.push('', '⛔ فضای سرور کافی نیست.');
    else if (t.size > 0) rows.push([btn('✅ شروع انتقال', 'uiGo')]);
    else L.push('', 'چیزی برای انتقال انتخاب نشده است.');
    rows.push([btn('↩️ حافظه‌ها', 'ud'), btn('✖️ انصراف', 'uiQ')]);
    return present('usb', mid, L.join('\n').slice(0, 3900), kb(...rows));
  }

  function listView(mid, page) {
    const w = W(); if (!w) return review(mid);
    const r = w.res;
    const all = [...r.movies.map((it, i) => ['m', i, it]), ...r.series.map((it, i) => ['s', i, it]), ...r.unknown.map((it, i) => ['u', i, it])];
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.max(0, Math.min(page, pages - 1)); w.page = page; store.save();
    const rows = [];
    for (const [c, i, it] of all.slice(page * PAGE, (page + 1) * PAGE)) {
      if (c === 'u') { rows.push([btn(`❓ ${short(it.title || (it.file || it.eps[0]).name, 26)}`, `uiE:u:${i}`), btn('✏️ تطبیق', `uiE:u:${i}`)]); continue; }
      const s = (c === 'm' ? w.sel.movies : w.sel.series)[i];
      const label = `${s.on ? '✅' : '⬜'} ${it.needsConfirm ? '⚠️' : c === 'm' ? '🎬' : '📺'} ${short(it.match.title, 22)}${it.match.year ? ` ${it.match.year}` : ''}`;
      const row = [btn(label, `uiT:${c}:${i}`), btn('✏️', `uiE:${c}:${i}`)];
      if (it.dup || it.dups) row.push(btn(s.replace ? '♻️ جایگزین' : '⏭ رد تکراری', `uiD:${c}:${i}`));
      rows.push(row);
    }
    if (pages > 1) rows.push([btn('◀️', `uiL:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `uiL:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([btn('↩️ خلاصه', 'uiR')]);
    return present('usb', mid, '📋 موارد تشخیص‌داده‌شده\n\n✅/⬜ انتقال یا عدم انتقال · ✏️ اصلاح تطبیق (اگر اشتباه تشخیص داده شده)\n♻️ برای موارد موجود در آرشیو: رد کردن (پیش‌فرض) یا جایگزینی', kb(...rows));
  }
  const itemOf = (c, i) => { const w = W(); if (!w) return null; const arr = c === 'm' ? w.res.movies : c === 's' ? w.res.series : w.res.unknown; return arr[Number(i)] || null; };
  async function editView(mid, c, i, cands) {
    const w = W(); const it = itemOf(c, i); if (!it) return review(mid);
    const kind = it.kind;
    if (!cands) cands = it.cands && it.cands.length ? it.cands : await (kind === 'movie' ? I.searchMovies(it.title + (it.year ? ` ${it.year}` : '')) : I.searchSeries(it.title)).catch(() => []);
    w.edit = { c, i: Number(i), cands }; store.save();
    const src = it.file ? it.file.rel : it.eps[0].rel;
    const L = [`✏️ تطبیق ${kind === 'movie' ? 'فیلم' : 'سریال'}`, `📄 ${short(src, 70)}`, `🔤 اسم تشخیص‌داده‌شده: ${it.title || '-'}${it.year ? ` (${it.year})` : ''}`, ''];
    L.push(it.match ? `فعلاً: ${it.match.title}${it.match.year ? ` (${it.match.year})` : ''}` : 'فعلاً تطبیقی پیدا نشده.');
    L.push('', cands.length ? 'یکی از نتیجه‌ها را انتخاب کن:' : 'نتیجه‌ای نبود؛ اسم دیگری را جست‌وجو کن.');
    const rows = cands.slice(0, 8).map((x, k) => [btn(`${x.id ? '📚 ' : ''}${short(x.title, 30)}${x.year ? ` (${x.year})` : ''}`, `uiC:${k}`)]);
    rows.push([btn('🔎 جست‌وجوی اسم دیگر', 'uiF')]);
    rows.push([btn(kind === 'movie' ? '📺 این سریال است' : '🎬 این فیلم است', 'uiK')].filter(() => c === 'u'));
    rows.push([btn('↩️ فهرست', `uiL:${w.page || 0}`)]);
    return present('usb', mid, L.join('\n'), kb(...rows));
  }
  async function pick(mid, k) {
    const w = W(); if (!w || !w.edit) return review(mid);
    const { c, i, cands } = w.edit; const it = itemOf(c, i); const cand = cands[Number(k)];
    if (!it || !cand) return review(mid);
    await I.rematch(it, cand);
    if (c === 'u') {
      w.res.unknown.splice(i, 1);
      if (it.kind === 'movie') { w.res.movies.push(it); w.sel.movies[w.res.movies.length - 1] = { on: true, replace: false }; }
      else { w.res.series.push(it); w.sel.series[w.res.series.length - 1] = { on: true, replace: false }; }
    }
    w.edit = null; store.save();
    return listView(mid, w.page || 0);
  }
  async function onText(aw, text) {
    const w = W(); if (!w || !w.edit) return bale.send('این بررسی منقضی شده است.');
    const it = itemOf(w.edit.c, w.edit.i); if (!it) return null;
    const cands = await (it.kind === 'movie' ? I.searchMovies(text) : I.searchSeries(text)).catch(() => []);
    return editView(null, w.edit.c, w.edit.i, cands);
  }
  async function go(cb, mid) {
    const w = W(); if (!w) { await bale.answer(cb.id); return review(mid); }
    const x = w.res.drive.ident ? S.findByIdent({ type: 'usb', ident: w.res.drive.ident }) : null;
    if (!x) return bale.answer(cb.id, 'این حافظه دیگر وصل نیست', true);
    const t = totals(w);
    if (t.size + 1073741824 > dfData()) return bale.answer(cb.id, 'فضای سرور کافی نیست', true);
    const spec = I.build(w.res, w.sel, { uid: ctx.uid() });
    if (!spec.files.length) return bale.answer(cb.id, 'چیزی برای انتقال نیست', true);
    const job = J.create(spec);
    P.audit(ctx.uid(), 'usb_import', 'import', `${w.res.drive.name}/${w.res.root || ''} ${spec.files.length} files ${t.size}`);
    d.impw = null; store.save();
    await bale.answer(cb.id, '📤 شروع شد');
    return present('usb', mid, `✅ انتقال به سرور در صف قرار گرفت (${fa(spec.files.length)} فایل، ${U.bytes(t.size)}).\nفایل‌ها اول در پوشه‌ی موقت روی سرور کپی و بررسی می‌شوند، بعد وارد آرشیو می‌شوند. تا پایان کار، جداسازی این حافظه ممکن نیست.`, kb([btn('📊 پیشرفت', `ujs:${job.id}`), btn('↩️ حافظه‌ها', 'ud')]));
  }

  async function onCallback(cb, a, p) {
    const mid = cb.message.message_id;
    const w = W();
    switch (a) {
      case 'uiS': await bale.answer(cb.id, '🔎 بررسی شروع شد'); return start(mid, p[0], '');
      case 'uiH': { const b = d.usbBrowse; await bale.answer(cb.id, '🔎 بررسی شروع شد'); if (!b) return null; return start(mid, b.id, b.rel); }
      case 'uiR': await bale.answer(cb.id); return review(mid);
      case 'uiL': await bale.answer(cb.id); return listView(mid, Number(p[0]) || 0);
      case 'uiT': { if (!w) break; const s = (p[0] === 'm' ? w.sel.movies : w.sel.series)[p[1]]; if (s) s.on = !s.on; const ti = itemOf(p[0], p[1]); if (s && s.on && ti && ti.needsConfirm) { ti.needsConfirm = false; ti.conf = 'confirmed'; } store.save(); await bale.answer(cb.id); return listView(mid, w.page || 0); }
      case 'uiD': {
        if (!w) break; const s = (p[0] === 'm' ? w.sel.movies : w.sel.series)[p[1]]; const it = itemOf(p[0], p[1]);
        if (s) s.replace = !s.replace; store.save();
        const note = s && s.replace && it && it.kind === 'movie' && it.dup && it.dup.size >= it.size ? 'نسخه‌ی موجود بزرگ‌تر یا هم‌اندازه است!' : '';
        await bale.answer(cb.id, note, !!note); return listView(mid, w.page || 0);
      }
      case 'uiE': await bale.answer(cb.id, '🔎'); return editView(mid, p[0], p[1]);
      case 'uiC': await bale.answer(cb.id, '⏳'); return pick(mid, p[0]);
      case 'uiF': { if (!w || !w.edit) break; await bale.answer(cb.id); d.await = { type: 'imp_search', until: Date.now() + 300000 }; store.save(); return bale.send('🔎 اسم درست را (ترجیحاً انگلیسی، با سال) بفرست.'); }
      case 'uiK': { if (!w || !w.edit) break; const it = itemOf(w.edit.c, w.edit.i); if (it) { it.kind = it.kind === 'movie' ? 'series' : 'movie'; if (it.kind === 'series' && !it.eps) { it.eps = [{ ...it.file, s: 1, e: [1] }]; } if (it.kind === 'movie' && !it.file) it.file = it.eps[0]; it.cands = []; } store.save(); await bale.answer(cb.id); return editView(mid, w.edit.c, w.edit.i); }
      case 'uiTo': if (!w) break; w.sel.other = !w.sel.other; store.save(); await bale.answer(cb.id); return review(mid);
      case 'uiTu': if (!w) break; w.sel.unknownAsOther = !w.sel.unknownAsOther; store.save(); await bale.answer(cb.id); return review(mid);
      case 'uiGo': return go(cb, mid);
      case 'uiQ': d.impw = null; store.save(); await bale.answer(cb.id, 'لغو شد'); return bale.del(mid);
      default: break;
    }
    await bale.answer(cb.id);
    return review(mid);
  }
  return { onCallback, onText, start };
};
