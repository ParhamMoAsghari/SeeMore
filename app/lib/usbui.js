'use strict';
// «💾 حافظه‌های خارجی» section: drive list, browsing, file details (metadata), file management
// (move / copy / rename / new folder / delete), copy-from-library wizard, safe eject, plug notices.
// Transfers run in the durable job engine (jobs.js); progress is rendered by jobsui.js.
const path = require('path');
const fs = require('fs');
const S = require('./usb');
const J = require('./jobs');
const U = require('./util');
const P = require('./perms');
const ctx = require('./ctx');
const META = require('./meta');
const { metaText } = require('./metaview');
const { fan } = require('./fan');

const btn = (text, cb) => ({ text, callback_data: cb });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const BROWSE_PAGE = 10, LIST_PAGE = 8, EP_PAGE = 20;
const short = (s, n = 34) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const icon = (e) => (e.dir ? '📁' : S.VIDEO.test(e.name) ? '🎞' : S.SUBS.test(e.name) ? '💬' : /\.(jpe?g|png|gif|webp|heic|bmp)$/i.test(e.name) ? '🖼' : /\.(mp3|flac|m4a|wav|ogg)$/i.test(e.name) ? '🎵' : /\.(zip|rar|7z|tar|gz)$/i.test(e.name) ? '🗜' : /\.pdf$/i.test(e.name) ? '📕' : '📄');
const fa = (n) => Number(n).toLocaleString('fa-IR');
const userErr = (m) => Object.assign(new Error(m), { user: true });

const UO = require('./svc/usbops');
module.exports = function createUsb(bale, store, present, hooks = {}) {
  const d = store.d;
  d.usbKnown = d.usbKnown || {};
  const can = (p) => P.can(ctx.uid(), p);
  const uuidOf = (x) => x.uuid || x.id;
  const ep = (x) => S.endpoint(x);

  const driveLine = (x) => {
    const pct = x.total ? Math.round((x.used / x.total) * 100) : 0;
    return `💾 ${x.title}${x.title !== x.name ? ` (${x.name})` : ''}\n   ${x.fsName}${x.ro ? ' · فقط‌خواندنی' : ''} · آزاد ${U.bytes(x.free)} از ${U.bytes(x.total)}\n   ${U.bar(pct)} ${pct}% پر${x.fsck ? `\n   🩺 ${x.fsck}` : ''}`;
  };
  const noDrive = '💾 هیچ حافظه‌ی خارجی (فلش یا هارد) به سرور وصل نیست.\n\nحافظه را به یکی از پورت‌های USB سرور وصل کن؛ چند ثانیه بعد خبرت می‌کنم.';

  // ---------- drives ----------
  async function showDrives(mid) {
    const ds = S.readDrives();
    const act = J.list({ active: true });
    let text = ds.length ? `💾 حافظه‌های خارجی وصل‌شده\n\n${ds.map(driveLine).join('\n\n')}` : noDrive;
    if (act.length) text += `\n\n⏳ ${fa(act.length)} کار انتقال فعال، در صف یا منتظر حافظه است.`;
    const rows = [];
    for (const x of ds) {
      rows.push([btn(`📂 ${short(x.title, 22)}`, `ub:${x.id}`), btn('⏏️ جداسازی', `ue:${x.id}`)]);
      if (can('usb_import')) rows.push([btn(`📤 انتقال «${short(x.title, 16)}» به سرور`, `uiS:${x.id}`)]);
    }
    if (ds.length && can('usb_copy')) rows.push([btn('📥 کپی از کتابخانه روی حافظه', 'uc')]);
    for (const j of act.slice(0, 3)) if (P.isOwner(ctx.uid()) || j.uid === ctx.uid()) rows.push([btn(`📊 ${short(j.title, 28)}`, `ujs:${j.id}`)]);
    rows.push([btn('🔄 تازه‌سازی', 'ud'), btn('✖️ بستن', 'close')]);
    return present('usb', mid, text, kb(...rows));
  }
  function needDrive(id) {
    const x = S.getDrive(id);
    if (!x) throw userErr('این حافظه دیگر وصل نیست.');
    return x;
  }

  // ---------- browse ----------
  async function browse(mid, id, rel, page = 0) {
    const x = needDrive(id);
    let ents;
    try { ents = await S.listDir(x, rel); } catch (e) { if (rel) return browse(mid, id, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), 0); throw e; }
    const pages = Math.max(1, Math.ceil(ents.length / BROWSE_PAGE));
    page = Math.max(0, Math.min(page, pages - 1));
    d.usbBrowse = { id, rel, page, names: ents.map((e) => e.name), dirs: ents.map((e) => e.dir) };
    store.save();
    const dirs = ents.filter((e) => e.dir).length, files = ents.length - dirs;
    const fsize = ents.filter((e) => !e.dir).reduce((a, e) => a + e.size, 0);
    const mv = d.usbMove;
    let text = '';
    if (mv) text += `${mv.op === 'move' ? '✂️ جابه‌جایی' : '📋 کپی'} «${short(mv.name, 40)}» از ${mv.driveName}\nپوشه‌ی مقصد را باز کن و «${mv.op === 'move' ? 'انتقال' : 'کپی'} به اینجا» را بزن.\n\n`;
    text += `📂 ${x.name}${rel ? '/' + rel : ''}\n💽 ${x.fsName}${x.ro ? ' · فقط‌خواندنی' : ''} · آزاد ${U.bytes(x.free)} از ${U.bytes(x.total)}\n\n`;
    text += ents.length ? `📁 ${fa(dirs)} پوشه · 📄 ${fa(files)} فایل${files ? ` (${U.bytes(fsize)})` : ''}${pages > 1 ? `\nصفحه‌ی ${fa(page + 1)} از ${fa(pages)}` : ''}` : 'این پوشه خالی است.';
    const rows = ents.slice(page * BROWSE_PAGE, (page + 1) * BROWSE_PAGE).map((e, i) => {
      const k = page * BROWSE_PAGE + i;
      return [btn(`${icon(e)} ${short(e.name, 36)}${e.dir ? '' : ` · ${U.bytes(e.size)}`}`, e.dir ? `ubo:${k}` : `ubf:${k}`)];
    });
    if (pages > 1) rows.push([btn('◀️', `ubp:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `ubp:${Math.min(pages - 1, page + 1)}`)]);
    if (mv) {
      rows.push([btn(mv.op === 'move' ? '📥 انتقال به اینجا' : '📋 کپی به اینجا', 'umh')].filter(() => !x.ro), [btn('✖️ لغو جابه‌جایی', 'umq')]);
      const r2 = []; if (rel) r2.push(btn('⬆️ پوشه‌ی بالا', 'ubu'));
      if (S.readDrives().length > 1) r2.push(btn('💾 حافظه‌ی دیگر', 'umd'));
      rows.push(r2);
      return present('usb', mid, text, kb(...rows));
    }
    const r2 = [];
    if (rel) r2.push(btn('⬆️ پوشه‌ی بالا', 'ubu'));
    if (!x.ro && can('usb_copy')) r2.push(btn('📥 کپی از کتابخانه به اینجا', 'uch'));
    rows.push(r2);
    const r3 = [];
    if (!x.ro && can('usb_manage')) r3.push(btn('📁 پوشه‌ی جدید', 'umk'));
    if (can('usb_import')) r3.push(btn(rel ? '📤 انتقال این پوشه به سرور' : '📤 انتقال به سرور', 'uiH'));
    rows.push(r3);
    if (rel && can('usb_manage')) rows.push([btn('⚙️ مدیریت این پوشه', 'umF')]);
    rows.push([btn('⏏️ جداسازی امن', `ue:${id}`), btn('↩️ حافظه‌ها', 'ud'), btn('✖️ بستن', 'close')]);
    return present('usb', mid, text, kb(...rows));
  }
  function bentry(i) {
    const b = d.usbBrowse; if (!b) return null;
    const name = b.names[Number(i)]; if (name == null) return null;
    return { b, name, dir: !!(b.dirs && b.dirs[Number(i)]), rel: b.rel ? `${b.rel}/${name}` : name };
  }
  async function fileView(mid, i) {
    const e = bentry(i); if (!e) return showDrives(mid);
    const x = needDrive(e.b.id);
    bale.action('typing');
    const m = await META.inspect(S.safeJoin(x.mount, e.rel));
    const text = metaText(m, `${x.name}/${e.rel}`);
    const rows = [];
    if (!x.ro && can('usb_manage')) rows.push([btn('✂️ جابه‌جایی', `umm:${i}`), btn('📋 کپی', `umc:${i}`), btn('✏️ تغییر نام', `umr:${i}`)], [btn('🗑 حذف فایل', `ubx:${i}`)]);
    rows.push([btn('↩️ بازگشت', `ubp:${e.b.page}`), btn('✖️ بستن', 'close')]);
    return present('usb', mid, text, kb(...rows));
  }
  async function folderMenu(mid) {
    const b = d.usbBrowse; if (!b || !b.rel) return showDrives(mid);
    const x = needDrive(b.id);
    const sz = await S.dirSize(S.safeJoin(x.mount, b.rel));
    const text = `⚙️ پوشه‌ی «${path.posix.basename(b.rel)}»\n📂 ${x.name}/${b.rel}\n📦 ${U.bytes(sz)}`;
    const rows = [];
    if (!x.ro) rows.push([btn('✂️ جابه‌جایی', 'umm:.'), btn('📋 کپی', 'umc:.'), btn('✏️ تغییر نام', 'umr:.')], [btn('🗑 حذف این پوشه', 'ubD')]);
    rows.push([btn('↩️ بازگشت', `ubp:${b.page}`)]);
    return present('usb', mid, text, kb(...rows));
  }

  // ---------- file management ----------
  function busyCheck(x, rel) {
    const abs = S.safeJoin(x.mount, rel);
    if (J.pathBusy(abs)) throw userErr('یک کار انتقال الان روی این مسیر می‌خواند یا می‌نویسد. بعد از تمام شدنش دوباره امتحان کن.');
    return abs;
  }
  function startMove(op, i) {
    const b = d.usbBrowse; if (!b) return null;
    const x = needDrive(b.id);
    const e = i === '.' ? { rel: b.rel, name: path.posix.basename(b.rel), dir: true } : bentry(i);
    if (!e || !e.rel) return null;
    busyCheck(x, e.rel);
    d.usbMove = { op, drive: x.id, uuid: uuidOf(x), driveName: x.name, rel: e.rel, name: e.name, dir: e.dir, t: Date.now() };
    store.save();
    const up = path.posix.dirname(e.rel);
    return { id: x.id, rel: up === '.' ? '' : up };
  }
  async function doPaste(cb, mid, mode = 'ask') {
    const mv = d.usbMove; const b = d.usbBrowse;
    if (!mv || !b) { await bale.answer(cb.id); return showDrives(mid); }
    const src = S.readDrives().find((y) => uuidOf(y) === mv.uuid || y.id === mv.drive);
    if (!src) { d.usbMove = null; store.save(); return bale.answer(cb.id, 'حافظه‌ی مبدأ دیگر وصل نیست', true); }
    const dst = needDrive(b.id);
    if (dst.ro) return bale.answer(cb.id, 'این حافظه فقط‌خواندنی است', true);
    busyCheck(src, mv.rel); busyCheck(dst, b.rel || '.');
    const same = src.id === dst.id;
    const srcAbs = S.safeJoin(src.mount, mv.rel), dirAbs = S.safeJoin(dst.mount, b.rel);
    if (same && (dirAbs === srcAbs || dirAbs.startsWith(srcAbs + '/'))) return bale.answer(cb.id, 'نمی‌شود یک پوشه را به داخل خودش برد', true);
    if (same && path.dirname(srcAbs) === dirAbs && mv.op === 'move') return bale.answer(cb.id, 'مبدأ و مقصد یکی است', true);
    let name = mv.name;
    const exists = await S.exists(path.join(dirAbs, name));
    if (exists && mode === 'ask') {
      await bale.answer(cb.id);
      return present('usb', mid, `⚠️ در مقصد «${name}» از قبل هست.\nچه کار کنم؟`, kb([btn('♻️ جایگزین کن', 'umh:o'), btn('📑 هر دو بماند', 'umh:k')], [btn('↩️ انصراف', `ubp:${b.page}`)]));
    }
    if (exists && mode === 'keep') name = await S.freeName(dirAbs, name);
    if (same && mv.op === 'move') {
      const r = await S.moveOn(dst, mv.rel, b.rel, mode === 'keep' ? 'keep' : mode === 'overwrite' ? 'overwrite' : 'ask');
      if (r.conflict) return bale.answer(cb.id, 'نام تکراری', true);
      P.audit(ctx.uid(), 'usb_manage', 'move', `${src.name}/${mv.rel} -> ${b.rel || '/'}`);
      d.usbMove = null; store.save();
      await bale.answer(cb.id, '✅ منتقل شد');
      return browse(mid, dst.id, b.rel, 0);
    }
    // copy (same drive) or cross-drive copy/move -> durable job with progress (shared core service)
    let r;
    try { r = await UO.transfer(ctx.uid(), { from: src.id, rel: mv.rel, to: dst.id, destRel: b.rel || '', op: mv.op, mode: exists ? (mode === 'overwrite' ? 'overwrite' : 'keep') : 'keep' }); }
    catch (e) { return bale.answer(cb.id, e.message, true); }
    const job = r.job; const files = { length: r.files }; const need = r.need;
    d.usbMove = null; store.save();
    await bale.answer(cb.id, '📤 در صف قرار گرفت');
    return present('usb', mid, `✅ ${mv.op === 'move' ? 'جابه‌جایی' : 'کپی'} «${short(mv.name, 40)}» شروع شد (${fa(files.length)} فایل، ${U.bytes(need)}).\nپیشرفت را در پیام بعدی می‌بینی.`, kb([btn('📂 مقصد', `ub:${dst.id}`), btn('📊 پیشرفت', `ujs:${job.id}`)]));
  }
  async function onText(aw, text) {
    const x = S.getDrive(aw.drive);
    if (!x) return bale.send('این حافظه دیگر وصل نیست.');
    try {
      if (aw.type === 'usb_mkdir') {
        const rel = await S.mkdirOn(x, aw.rel, text);
        P.audit(ctx.uid(), 'usb_manage', 'mkdir', `${x.name}/${rel}`);
        await bale.send(`📁 پوشه‌ی «${text.trim()}» ساخته شد.`);
        return browse(null, x.id, aw.rel, 0);
      }
      if (aw.type === 'usb_rename') {
        busyCheck(x, aw.rel);
        const rel = await S.renameOn(x, aw.rel, text);
        P.audit(ctx.uid(), 'usb_manage', 'rename', `${x.name}/${aw.rel} -> ${rel}`);
        await bale.send(`✏️ اسم به «${path.posix.basename(rel)}» تغییر کرد.`);
        const up = path.posix.dirname(rel);
        return browse(null, x.id, aw.isFolder ? rel : up === '.' ? '' : up, 0);
      }
    } catch (e) { if (e.user || e.code) return bale.send(`⚠️ ${e.user ? e.message : e.code === 'EEXIST' ? 'این اسم از قبل هست' : U.trunc(e.message, 120)}`); throw e; }
  }

  // ---------- copy wizard ----------
  const W = () => d.usbw;
  async function wizStart(mid, preset) {
    const ds = S.readDrives().filter((x) => !x.ro);
    if (!ds.length) return present('usb', mid, noDrive, kb([btn('🔄 تازه‌سازی', 'ud'), btn('✖️ بستن', 'close')]));
    d.usbw = { t: Date.now(), sel: [], drive: preset ? preset.id : null, folder: preset ? preset.folder : '' };
    store.save();
    const lib = await S.library(true);
    const where = preset ? `\n💾 مقصد: ${S.getDrive(preset.id).name}/${preset.folder}` : '';
    return present('usb', mid, `📥 کپی روی فلش${where}\n\nچه چیزی کپی شود؟\n🎬 ${fa(lib.m.length)} فیلم · 📺 ${fa(lib.s.length)} سریال در کتابخانه`,
      kb([btn('🎬 فیلم', 'ucm:0'), btn('📺 سریال', 'ucs:0')], [btn('✖️ انصراف', 'close')]));
  }
  async function listView(mid, k, page) {
    const w = W(); if (!w) return wizStart(mid);
    const lib = await S.library();
    const arr = k === 'm' ? lib.m : lib.s;
    w.k = k; w.names = arr.map((x) => x.name); store.save();
    if (!arr.length) return present('usb', mid, k === 'm' ? 'هنوز فیلمی در کتابخانه نیست.' : 'هنوز سریالی در کتابخانه نیست.', kb([btn('↩️ بازگشت', 'uc')]));
    const pages = Math.ceil(arr.length / LIST_PAGE);
    page = Math.max(0, Math.min(page, pages - 1));
    const rows = arr.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE).map((x, i) => [btn(`${k === 'm' ? '🎬' : '📺'} ${short(x.name, 30)} · ${k === 's' ? `${fa(x.eps.length)} قسمت · ` : ''}${U.bytes(x.size)}`, `${k === 'm' ? 'ucM' : 'ucS'}:${page * LIST_PAGE + i}`)]);
    if (pages > 1) rows.push([btn('◀️', `uc${k}:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `uc${k}:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([btn('↩️ بازگشت', 'ucb0'), btn('✖️ انصراف', 'close')]);
    return present('usb', mid, k === 'm' ? '🎬 کدام فیلم کپی شود؟' : '📺 کدام سریال؟', kb(...rows));
  }
  async function series() {
    const w = W(); if (!w || w.k !== 's' || w.si == null) return null;
    const lib = await S.library();
    return lib.s.find((x) => x.name === w.names[w.si]) || null;
  }
  const selSize = (sr, sel) => sel.reduce((a, i) => a + (sr.eps[i] ? sr.eps[i].size : 0), 0);
  async function seasonsView(mid) {
    const w = W(); const sr = await series(); if (!sr) return wizStart(mid);
    const rows = sr.seasons.map((s) => {
      const idx = sr.eps.map((e, i) => (e.s === s ? i : -1)).filter((i) => i >= 0);
      const n = idx.filter((i) => w.sel.includes(i)).length;
      return [btn(`${n === idx.length ? '✅' : n ? '☑️' : '⬜'} ${s ? `فصل ${fa(s)}` : 'بدون فصل'} · ${fa(n)}/${fa(idx.length)} قسمت`, `ucp:${s}:0`)];
    });
    rows.push([btn('✅ همه‌ی فصل‌ها', 'uca:all'), btn('⬜ هیچ‌کدام', 'ucn:all')]);
    rows.push([btn(`➡️ ادامه (${fa(w.sel.length)})`, 'ucy')]);
    rows.push([btn('↩️ سریال‌ها', 'ucs:0'), btn('✖️ انصراف', 'close')]);
    return present('usb', mid, `📺 ${sr.name}\n\nفصل را باز کن و قسمت‌ها را علامت بزن.\nانتخاب‌شده: ${fa(w.sel.length)} قسمت (${U.bytes(selSize(sr, w.sel))})`, kb(...rows));
  }
  async function episodesView(mid, s, page) {
    const w = W(); const sr = await series(); if (!sr) return wizStart(mid);
    const idx = sr.eps.map((e, i) => (e.s === s ? i : -1)).filter((i) => i >= 0);
    const pages = Math.max(1, Math.ceil(idx.length / EP_PAGE));
    page = Math.max(0, Math.min(page, pages - 1));
    w.season = s; w.epage = page; store.save();
    const items = idx.slice(page * EP_PAGE, (page + 1) * EP_PAGE).map((i) => {
      const e = sr.eps[i];
      return btn(`${w.sel.includes(i) ? '✅' : '⬜'} ${e.e ? `قسمت ${fa(e.e)}` : short(e.name, 14)} · ${U.bytes(e.size)}${e.subs.length ? ' 💬' : ''}`, `uce:${i}`);
    });
    const rows = [];
    for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
    if (pages > 1) rows.push([btn('◀️', `ucp:${s}:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `ucp:${s}:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([btn('☑️ همه قسمت‌ها', `uca:${s}`), btn('⬜ هیچ‌کدام', `ucn:${s}`)]);
    rows.push([btn(`➡️ ادامه (${fa(w.sel.length)})`, 'ucy')]);
    rows.push([btn('↩️ فصل‌ها', 'ucz'), btn('✖️ انصراف', 'close')]);
    const n = idx.filter((i) => w.sel.includes(i)).length;
    return present('usb', mid, `📺 ${sr.name} · ${s ? `فصل ${fa(s)}` : 'بدون فصل'}\n\nقسمت‌های موردنظر را علامت بزن (💬 یعنی زیرنویس دارد).\nاز این فصل: ${fa(n)} از ${fa(idx.length)} · کل انتخاب: ${fa(w.sel.length)} قسمت (${U.bytes(selSize(sr, w.sel))})`, kb(...rows));
  }
  // build copy items from the wizard selection
  async function items() {
    const w = W(); const lib = await S.library();
    const out = [];
    const push = (f, dstDir) => {
      out.push({ src: f.src, size: f.size, dst: `${dstDir}/${f.name}` });
      for (const s of f.subs) out.push({ src: s.src, size: s.size, dst: `${dstDir}/${s.name}`, sub: true });
    };
    if (w.k === 'm') {
      const mv = lib.m.find((x) => x.name === w.movie); if (!mv) return { title: '', out };
      for (const f of mv.files) push(f, mv.name);
      return { title: `🎬 ${mv.name}`, out };
    }
    const sr = await series(); if (!sr) return { title: '', out };
    const sel = [...w.sel].sort((a, b) => a - b);
    for (const i of sel) { const e = sr.eps[i]; if (e) push(e, e.rel ? `${sr.name}/${e.rel}` : sr.name); }
    const ss = [...new Set(sel.map((i) => sr.eps[i] && sr.eps[i].s))].filter((x) => x != null);
    return { title: `📺 ${sr.name} · ${fa(sel.length)} قسمت${ss.length === 1 && ss[0] ? ` از فصل ${fa(ss[0])}` : ss.length > 1 ? ` از ${fa(ss.length)} فصل` : ''}`, out };
  }
  async function stepDrive(mid) {
    const w = W(); if (!w) return wizStart(mid);
    if (w.k === 's' && !w.sel.length) return null;
    const ds = S.readDrives().filter((x) => !x.ro);
    if (!ds.length) return present('usb', mid, noDrive, kb([btn('🔄 تازه‌سازی', 'ud'), btn('✖️ بستن', 'close')]));
    if (w.drive && ds.some((x) => x.id === w.drive)) return confirmView(mid);
    if (ds.length === 1) { w.drive = ds[0].id; w.folder = ''; store.save(); return confirmView(mid); }
    return present('usb', mid, '💾 روی کدام فلش یا هارد کپی شود؟', kb(...ds.map((x) => [btn(`💾 ${short(x.title, 22)} · آزاد ${U.bytes(x.free)}`, `ucd:${x.id}`)]), [btn('↩️ بازگشت', 'ucb'), btn('✖️ انصراف', 'close')]));
  }
  async function confirmView(mid) {
    const w = W(); const x = needDrive(w.drive);
    const { title, out } = await items();
    if (!out.length) return wizStart(mid);
    const p = await S.plan(x, out, w.folder);
    w.plan = { title, files: p.files, need: p.need }; store.save();
    const vids = p.files.filter((f) => !f.sub), subs = p.files.filter((f) => f.sub);
    const firstDir = path.posix.dirname(p.files[0].dst);
    let text = `📋 خلاصه‌ی کپی\n\n${title}\n🎞 ${fa(vids.length)} فایل ویدیو${subs.length ? ` + 💬 ${fa(subs.length)} زیرنویس` : ''}\n💾 مقصد: ${x.name}/${firstDir}${p.files.some((f) => path.posix.dirname(f.dst) !== firstDir) ? ' و ...' : ''}\n📦 حجم کپی: ${U.bytes(p.need)}\n💽 فضای آزاد: ${U.bytes(p.free)}${p.enough ? ` → بعد از کپی ${U.bytes(p.free - p.need)}` : ''}`;
    if (p.exists.length) text += `\n\n♻️ ${fa(p.exists.length)} فایل از قبل با همین حجم روی فلش هست و دوباره کپی نمی‌شود.`;
    if (p.fat.length) text += `\n\n⚠️ فرمت این فلش FAT32 است و فایل بزرگ‌تر از ۴ گیگابایت را نمی‌پذیرد. این ${fa(p.fat.length)} فایل کپی نمی‌شود:\n${p.fat.slice(0, 5).map((f) => `• ${short(path.posix.basename(f.dst), 45)} (${U.bytes(f.size)})`).join('\n')}${p.fat.length > 5 ? '\n• ...' : ''}\nبرای فایل‌های بزرگ، فلش را با فرمت exFAT یا NTFS فرمت کن.`;
    const rows = [];
    if (!p.need) text += '\n\nچیزی برای کپی نمانده است.';
    else if (!p.enough) { text += `\n\n⛔ فضای فلش کافی نیست. ${U.bytes(p.need)} لازم است ولی فقط ${U.bytes(p.free)} آزاد است. چند قسمت کمتر انتخاب کن یا از فلش فایل پاک کن.`; rows.push([btn('📂 مشاهده و پاک‌کردن فایل‌های فلش', `ub:${x.id}`)]); }
    else rows.push([btn('✅ شروع کپی', 'ucg')]);
    const r2 = [btn('↩️ بازگشت', 'ucb')];
    if (S.readDrives().filter((y) => !y.ro).length > 1) r2.push(btn('💾 تغییر مقصد', 'ucD'));
    rows.push(r2, [btn('✖️ انصراف', 'close')]);
    return present('usb', mid, text, kb(...rows));
  }
  async function go(mid) {
    const w = W(); if (!w || !w.plan) return wizStart(mid);
    const x = needDrive(w.drive);
    // same core service as POST /api/v1/storage/exports
    const job = await UO.copyStart(ctx.uid(), x.id, null, w.folder || '', { title: w.plan.title, files: w.plan.files, need: w.plan.need, enough: true });
    d.usbw = null; store.save();
    const ahead = J.list({ active: true }).filter((j) => j.id !== job.id).length;
    await present('usb', mid, `✅ به صف کپی اضافه شد${ahead ? ` (${fa(ahead)} کار جلوتر در صف است)` : ''}.\nپیشرفت را در پیام بعدی می‌بینی.`, kb([btn('↩️ حافظه‌ها', 'ud'), btn('✖️ بستن', 'close')]));
  }

  // ---------- eject ----------
  async function doEject(cb, mid, id) {
    const x = S.getDrive(id);
    if (!x) { await bale.answer(cb.id, 'این حافظه دیگر وصل نیست'); return showDrives(mid); }
    if (J.driveBusy(uuidOf(x))) return bale.answer(cb.id, 'یک کار انتقال الان از این حافظه می‌خواند یا رویش می‌نویسد. اول لغوش کن یا صبر کن تمام شود.', true);
    await bale.answer(cb.id, '⏏️ در حال جداسازی...');
    if (d.usbBrowse && d.usbBrowse.id === id) d.usbBrowse = null;
    d.usbEjecting = { id, t: Date.now() }; store.save();
    await present('usb', mid, `⏏️ در حال نوشتن داده‌های باقی‌مانده و جداسازی «${x.name}»...`, null);
    const r = await S.eject(id);
    if (r.ok) {
      delete d.usbKnown[id]; store.save();
      P.audit(ctx.uid(), 'usb_view', 'eject', x.name);
      return present('usb', mid, `✅ «${x.name}» با امنیت جدا شد.\nالان می‌توانی حافظه را از سرور جدا کنی.`, kb([btn('↩️ حافظه‌ها', 'ud'), btn('✖️ بستن', 'close')]));
    }
    d.usbEjecting = null; store.save();
    const why = /busy/.test(r.msg || '') ? 'یک برنامه هنوز از حافظه استفاده می‌کند. چند ثانیه بعد دوباره امتحان کن.' : r.msg === 'timeout' ? 'سرویس جداسازی روی سرور جواب نداد.' : U.trunc(r.msg, 150);
    return present('usb', mid, `⚠️ جداسازی «${x.name}» انجام نشد.\n${why}`, kb([btn('🔁 دوباره', `ue:${id}`), btn('↩️ حافظه‌ها', 'ud')]));
  }

  // ---------- callbacks ----------
  async function onCallback(cb, a, p) {
    const mid = cb.message.message_id;
    try {
      if (/^ui/.test(a) && hooks.importCb) return await hooks.importCb(cb, a, p);
      if (/^uj/.test(a) && hooks.jobsCb) return await hooks.jobsCb(cb, a, p);
      switch (a) {
        case 'ud': await bale.answer(cb.id); return showDrives(mid);
        case 'ub': await bale.answer(cb.id); return browse(mid, p[0], '', 0);
        case 'ubo': { await bale.answer(cb.id); const e = bentry(p[0]); if (!e) return showDrives(mid); return browse(mid, e.b.id, e.rel, 0); }
        case 'ubp': { await bale.answer(cb.id); const b = d.usbBrowse; if (!b) return showDrives(mid); return browse(mid, b.id, b.rel, Number(p[0])); }
        case 'ubu': { await bale.answer(cb.id); const b = d.usbBrowse; if (!b) return showDrives(mid); const up = path.posix.dirname(b.rel); return browse(mid, b.id, up === '.' ? '' : up, 0); }
        case 'ubf': await bale.answer(cb.id, '🔎'); return fileView(mid, p[0]);
        case 'ubx': {
          await bale.answer(cb.id); const e = bentry(p[0]); if (!e) return showDrives(mid);
          return present('usb', mid, `🗑 فایل «${e.name}» از حافظه حذف شود؟\nاین کار برگشت‌پذیر نیست.`, kb([btn('✅ بله، حذف کن', `ubxx:${p[0]}`)], [btn('↩️ انصراف', `ubf:${p[0]}`)]));
        }
        case 'ubxx': {
          const e = bentry(p[0]); if (!e) { await bale.answer(cb.id); return showDrives(mid); }
          const x = needDrive(e.b.id); busyCheck(x, e.rel);
          await S.removePath(x, e.rel); P.audit(ctx.uid(), 'usb_manage', 'delete', `${x.name}/${e.rel}`); await bale.answer(cb.id, '🗑 حذف شد');
          return browse(mid, e.b.id, e.b.rel, e.b.page);
        }
        case 'ubD': {
          await bale.answer(cb.id); const b = d.usbBrowse; if (!b || !b.rel) return showDrives(mid);
          const x = needDrive(b.id); const sz = await S.dirSize(S.safeJoin(x.mount, b.rel));
          return present('usb', mid, `🗑 پوشه‌ی «${b.rel}» با همه‌ی محتوایش (${U.bytes(sz)}) از حافظه حذف شود؟\nاین کار برگشت‌پذیر نیست.`, kb([btn('✅ بله، حذف کن', 'ubDD')], [btn('↩️ انصراف', `ubp:${b.page}`)]));
        }
        case 'ubDD': {
          const b = d.usbBrowse; if (!b || !b.rel) { await bale.answer(cb.id); return showDrives(mid); }
          const x = needDrive(b.id); busyCheck(x, b.rel);
          await S.removePath(x, b.rel); P.audit(ctx.uid(), 'usb_manage', 'delete', `${x.name}/${b.rel}`); await bale.answer(cb.id, '🗑 پوشه حذف شد');
          const up = path.posix.dirname(b.rel); return browse(mid, b.id, up === '.' ? '' : up, 0);
        }
        case 'ue': return doEject(cb, mid, p[0]);
        // file management
        case 'umF': await bale.answer(cb.id); return folderMenu(mid);
        case 'umm': case 'umc': {
          const r = startMove(a === 'umm' ? 'move' : 'copy', p[0]); if (!r) { await bale.answer(cb.id); return showDrives(mid); }
          await bale.answer(cb.id, 'مقصد را انتخاب کن'); return browse(mid, r.id, r.rel, 0);
        }
        case 'umh': return doPaste(cb, mid, p[0] === 'o' ? 'overwrite' : p[0] === 'k' ? 'keep' : 'ask');
        case 'umq': { d.usbMove = null; store.save(); await bale.answer(cb.id, 'لغو شد'); const b = d.usbBrowse; return b ? browse(mid, b.id, b.rel, b.page) : showDrives(mid); }
        case 'umd': { await bale.answer(cb.id); const ds = S.readDrives().filter((y) => !y.ro); return present('usb', mid, '💾 مقصد روی کدام حافظه باشد؟', kb(...ds.map((y) => [btn(`💾 ${short(y.title, 24)} · آزاد ${U.bytes(y.free)}`, `ub:${y.id}`)]), [btn('✖️ لغو جابه‌جایی', 'umq')])); }
        case 'umk': {
          const b = d.usbBrowse; if (!b) { await bale.answer(cb.id); return showDrives(mid); }
          await bale.answer(cb.id); d.await = { type: 'usb_mkdir', drive: b.id, rel: b.rel, until: Date.now() + 300000 }; store.save();
          return bale.send('📁 اسم پوشه‌ی جدید را بفرست.', kb([btn('✖️ انصراف', 'close')]));
        }
        case 'umr': {
          const b = d.usbBrowse; if (!b) { await bale.answer(cb.id); return showDrives(mid); }
          const e = p[0] === '.' ? { rel: b.rel, name: path.posix.basename(b.rel), dir: true } : bentry(p[0]);
          if (!e || !e.rel) { await bale.answer(cb.id); return showDrives(mid); }
          busyCheck(needDrive(b.id), e.rel);
          await bale.answer(cb.id); d.await = { type: 'usb_rename', drive: b.id, rel: e.rel, isFolder: p[0] === '.', until: Date.now() + 300000 }; store.save();
          return bale.send(`✏️ اسم جدید برای «${e.name}» را بفرست.`, kb([btn('✖️ انصراف', 'close')]));
        }
        case 'uc': await bale.answer(cb.id); return wizStart(mid);
        case 'uch': { await bale.answer(cb.id); const b = d.usbBrowse; if (!b) return wizStart(mid); return wizStart(mid, { id: b.id, folder: b.rel }); }
        case 'ucb0': { await bale.answer(cb.id); const w = W(); if (!w) return wizStart(mid); return wizStart(mid, w.drive ? { id: w.drive, folder: w.folder } : null); }
        case 'ucm': await bale.answer(cb.id); return listView(mid, 'm', Number(p[0]) || 0);
        case 'ucs': await bale.answer(cb.id); return listView(mid, 's', Number(p[0]) || 0);
        case 'ucM': { await bale.answer(cb.id); const w = W(); if (!w || !w.names) return wizStart(mid); w.k = 'm'; w.movie = w.names[Number(p[0])]; store.save(); return stepDrive(mid); }
        case 'ucS': { await bale.answer(cb.id); const w = W(); if (!w || !w.names) return wizStart(mid); w.k = 's'; w.si = Number(p[0]); w.sel = []; store.save(); const sr = await series(); if (sr && sr.seasons.length === 1) return episodesView(mid, sr.seasons[0], 0); return seasonsView(mid); }
        case 'ucz': await bale.answer(cb.id); return seasonsView(mid);
        case 'ucp': await bale.answer(cb.id); return episodesView(mid, Number(p[0]), Number(p[1]) || 0);
        case 'uce': {
          const w = W(); if (!w) { await bale.answer(cb.id); return wizStart(mid); }
          const i = Number(p[0]); w.sel = w.sel.includes(i) ? w.sel.filter((x) => x !== i) : [...w.sel, i]; store.save();
          await bale.answer(cb.id); return episodesView(mid, w.season, w.epage || 0);
        }
        case 'uca': case 'ucn': {
          const w = W(); const sr = await series(); if (!w || !sr) { await bale.answer(cb.id); return wizStart(mid); }
          const idx = sr.eps.map((e, i) => (p[0] === 'all' || e.s === Number(p[0]) ? i : -1)).filter((i) => i >= 0);
          w.sel = a === 'uca' ? [...new Set([...w.sel, ...idx])] : w.sel.filter((i) => !idx.includes(i)); store.save();
          await bale.answer(cb.id);
          return p[0] === 'all' ? seasonsView(mid) : episodesView(mid, Number(p[0]), w.epage || 0);
        }
        case 'ucy': { const w = W(); if (w && w.k === 's' && !w.sel.length) return bale.answer(cb.id, 'حداقل یک قسمت را انتخاب کن', true); await bale.answer(cb.id); return stepDrive(mid); }
        case 'ucD': { await bale.answer(cb.id); const w = W(); if (!w) return wizStart(mid); w.drive = null; w.folder = ''; store.save(); const ds = S.readDrives().filter((x) => !x.ro); return present('usb', mid, '💾 روی کدام فلش یا هارد کپی شود؟', kb(...ds.map((x) => [btn(`💾 ${short(x.title, 22)} · آزاد ${U.bytes(x.free)}`, `ucd:${x.id}`)]), [btn('↩️ بازگشت', 'ucb'), btn('✖️ انصراف', 'close')])); }
        case 'ucd': { await bale.answer(cb.id); const w = W(); if (!w) return wizStart(mid); w.drive = p[0]; w.folder = ''; store.save(); return confirmView(mid); }
        case 'ucb': { await bale.answer(cb.id); const w = W(); if (!w) return wizStart(mid); if (w.k === 's') return w.season != null ? episodesView(mid, w.season, w.epage || 0) : seasonsView(mid); return listView(mid, 'm', 0); }
        case 'ucg': await bale.answer(cb.id, '📤 شروع شد'); return go(mid);
        default: return bale.answer(cb.id);
      }
    } catch (e) {
      if (e.user) { await bale.answer(cb.id, e.message, true); return; }
      throw e;
    }
  }

  // ---------- plug / unplug notices (only users with usb_view) ----------
  function startWatcher() {
    let first = true;
    const tick = () => {
      try {
        const ds = S.readDrives();
        const now = new Set(ds.map((x) => x.id));
        for (const x of ds) {
          if (d.usbKnown[x.id] === x.mountedAt) continue;
          d.usbKnown[x.id] = x.mountedAt; store.save();
          S.ensureMarker(x).catch(() => {}); // seemore identity marker (.seemore/id) when the drive is writable
          const waiting = J.list({ active: true }).filter((j) => j.status === 'waiting' && [j.data.src, j.data.dst].some((e) => e && e.type === 'usb' && J.driveOf(e) && J.driveOf(e).id === x.id));
          const foreign = J.list({ active: true }).filter((j) => j.status === 'waiting' && [j.data.src, j.data.dst].some((e) => e && e.type === 'usb' && !J.driveOf(e) && (e.uuid && e.uuid === x.uuid || e.name === x.name)));
          const warn = (x.ro ? '\n⚠️ فقط‌خواندنی وصل شد (ممکن است حافظه خطا داشته باشد یا قبلاً درست جدا نشده باشد).' : x.fstype === 'vfat' ? '\nℹ️ فرمت FAT32 است؛ فایل‌های بزرگ‌تر از ۴ گیگابایت روی آن کپی نمی‌شوند.' : '')
            + (waiting.length ? `\n▶️ ${fa(waiting.length)} کار نیمه‌کاره‌ی این حافظه خودکار ادامه پیدا می‌کند.` : '')
            + (foreign.length ? `\n⚠️ این حافظه شبیه حافظه‌ی یک کار نیمه‌کاره است ولی هویتش یکی نیست (فلش دیگر یا فرمت‌شده)؛ آن کار روی این حافظه ادامه پیدا نمی‌کند.` : '');
          fan('usb_view', () => {
            const rows = [[btn('📂 مشاهده‌ی محتوا', `ub:${x.id}`)]];
            if (P.can(ctx.uid(), 'usb_import')) rows.push([btn('📤 انتقال به سرور', `uiS:${x.id}`)]);
            if (!x.ro && P.can(ctx.uid(), 'usb_copy')) rows.push([btn('📥 کپی از کتابخانه', 'uc')]);
            rows.push([btn('⏏️ جداسازی امن', `ue:${x.id}`)]);
            return bale.send(`🔌 حافظه‌ی جدید وصل شد\n\n${driveLine(x)}${warn}`, kb(...rows));
          }).catch(() => {});
        }
        for (const id of Object.keys(d.usbKnown)) {
          if (now.has(id)) continue;
          delete d.usbKnown[id]; store.save();
          const ej = d.usbEjecting && d.usbEjecting.id === id && Date.now() - d.usbEjecting.t < 120000;
          if (!first && !ej) fan('usb_view', () => bale.send('🔌 یک حافظه از سرور جدا شد.\nاگر قبلش «جداسازی امن» را نزده بودی، بعداً حافظه را روی کامپیوتر بررسی کن.')).catch(() => {});
        }
        first = false;
      } catch (e) { U.log('warn', 'usb watcher: ' + e.message); }
    };
    setTimeout(tick, 4000);
    setInterval(tick, 3000);
  }

  return { onCallback, onText, showDrives, browse, startWatcher, needDrive, shutdown: () => {} };
};
