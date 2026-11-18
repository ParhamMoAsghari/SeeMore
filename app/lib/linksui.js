'use strict';
// «🔗 لینک دانلود»: pick movies / seasons / episodes (multi-select across series), format, expiry,
// max downloads -> public + LAN links. «لینک‌های من»: counts, revoke, extend.
const path = require('path');
const S = require('./usb');
const L = require('./links');
const U = require('./util');
const P = require('./perms');
const W = require('./when');
const ctx = require('./ctx');
const SET = require('./settings');
const { asUser } = require('./fan');

const btn = (text, cb) => ({ text, callback_data: cb });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const fa = (n) => Number(n).toLocaleString('fa-IR');
const short = (s, n = 30) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const PAGE = 8, EPP = 20;
const ST = { active: '🟢 فعال', expired: '⌛ منقضی', revoked: '⛔ لغوشده', used: '🔒 سقف دانلود پر' };

module.exports = function createLinksUi(bale, store, present) {
  const d = store.d;
  const uid = () => ctx.uid();
  const w = () => d.lkw;
  async function menu(mid) {
    const mine = L.list({ uid: P.isOwner(uid()) ? null : uid(), limit: 100 });
    return present('links', mid, `🔗 لینک دانلود\n\nفیلم، چند قسمت یا یک یا چند فصل کامل از یک یا چند سریال را انتخاب کن تا یک لینک ZIP (بدون فشرده‌سازی، دانلود فوری با امکان ادامه) یا RAR بسازم. لینک هم از بیرون (${L.PUBLIC.replace(/^https?:\/\//, '')}) و هم از شبکه‌ی داخلی (${L.LAN.replace(/^https?:\/\//, '')}) کار می‌کند.`,
      kb([btn('➕ لینک جدید', 'lkN')], [btn(`📋 ${P.isOwner(uid()) ? 'همه‌ی لینک‌ها' : 'لینک‌های من'} (${fa(mine.filter((l) => L.state(l) === 'active').length)} فعال)`, 'lkM:0')], [btn('✖️ بستن', 'close')]));
  }
  const basket = () => (d.lkw = d.lkw || { m: [], e: {}, t: Date.now() });
  async function lib() { return S.library(); }
  async function summary() {
    const b = basket(); const l = await lib();
    let n = 0, size = 0;
    for (const name of b.m) { const mv = l.m.find((x) => x.name === name); if (mv) { n += mv.files.length; size += mv.size; } }
    for (const [sn, srcs] of Object.entries(b.e)) { const sr = l.s.find((x) => x.name === sn); if (sr) for (const e of sr.eps) if (srcs.includes(e.src)) { n++; size += e.size; } }
    return { n, size, items: b.m.length + Object.values(b.e).filter((x) => x.length).length };
  }
  async function pickRoot(mid) {
    const sm = await summary(); const l = await lib();
    return present('links', mid, `🧺 انتخاب برای لینک\n\nانتخاب‌شده: ${fa(sm.n)} ویدیو (${U.bytes(sm.size)})\n🎬 ${fa(l.m.length)} فیلم · 📺 ${fa(l.s.length)} سریال در کتابخانه`,
      kb([btn('🎬 فیلم‌ها', 'lkm:0'), btn('📺 سریال‌ها', 'lks:0')], sm.n ? [btn(`➡️ ادامه (${fa(sm.n)})`, 'lkF')] : [], [btn('🗑 خالی کردن', 'lkZ'), btn('↩️ بازگشت', 'lk')]));
  }
  async function listView(mid, k, page) {
    const l = await lib(); const b = basket(); const arr = k === 'm' ? l.m : l.s;
    const pages = Math.max(1, Math.ceil(arr.length / PAGE)); page = Math.max(0, Math.min(page, pages - 1));
    b.names = arr.map((x) => x.name); b.k = k; b.page = page; store.save();
    const rows = arr.slice(page * PAGE, (page + 1) * PAGE).map((x, i) => {
      const j = page * PAGE + i;
      if (k === 'm') return [btn(`${b.m.includes(x.name) ? '✅' : '⬜'} 🎬 ${short(x.name, 28)} · ${U.bytes(x.size)}`, `lkt:${j}`)];
      const n = x.eps.filter((e) => (b.e[x.name] || []).includes(e.src)).length;
      return [btn(`${n ? (n === x.eps.length ? '✅' : '☑️') : '⬜'} 📺 ${short(x.name, 24)} · ${fa(n)}/${fa(x.eps.length)}`, `lkS:${j}`)];
    });
    if (pages > 1) rows.push([btn('◀️', `lk${k}:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `lk${k}:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([btn('🧺 انتخاب‌ها', 'lkB')]);
    return present('links', mid, k === 'm' ? '🎬 فیلم‌ها را علامت بزن:' : '📺 سریال را باز کن و فصل یا قسمت‌ها را انتخاب کن:', kb(...rows));
  }
  async function seriesView(mid, si) {
    const l = await lib(); const b = basket(); const sr = l.s.find((x) => x.name === b.names[si]); if (!sr) return pickRoot(mid);
    b.si = si; store.save();
    const sel = b.e[sr.name] || [];
    const rows = sr.seasons.map((s) => {
      const idx = sr.eps.map((e, i) => (e.s === s ? i : -1)).filter((i) => i >= 0);
      const n = idx.filter((i) => sel.includes(sr.eps[i].src)).length;
      return [btn(`${n === idx.length ? '✅' : n ? '☑️' : '⬜'} ${s ? `فصل ${fa(s)}` : 'بدون فصل'} (کامل) · ${fa(idx.length)} قسمت`, `lkA:${s}`), btn('🔢 قسمت‌ها', `lkE:${s}:0`)];
    });
    rows.push([btn('↩️ سریال‌ها', `lks:${b.page || 0}`), btn('🧺 انتخاب‌ها', 'lkB')]);
    return present('links', mid, `📺 ${sr.name}\nانتخاب‌شده: ${fa(sr.eps.filter((e) => sel.includes(e.src)).length)} از ${fa(sr.eps.length)} قسمت\n\nفصل را کامل علامت بزن یا قسمت‌ها را جدا انتخاب کن.`, kb(...rows));
  }
  async function epsView(mid, s, page) {
    const l = await lib(); const b = basket(); const sr = l.s.find((x) => x.name === b.names[b.si]); if (!sr) return pickRoot(mid);
    const idx = sr.eps.map((e, i) => (e.s === s ? i : -1)).filter((i) => i >= 0);
    const pages = Math.max(1, Math.ceil(idx.length / EPP)); page = Math.max(0, Math.min(page, pages - 1));
    b.season = s; b.epage = page; store.save();
    const sel = b.e[sr.name] || [];
    const items = idx.slice(page * EPP, (page + 1) * EPP).map((i) => btn(`${sel.includes(sr.eps[i].src) ? '✅' : '⬜'} ${sr.eps[i].e ? `قسمت ${fa(sr.eps[i].e)}` : short(sr.eps[i].name, 14)} · ${U.bytes(sr.eps[i].size)}`, `lke:${i}`));
    const rows = []; for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
    if (pages > 1) rows.push([btn('◀️', `lkE:${s}:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `lkE:${s}:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([btn('↩️ فصل‌ها', `lkS:${b.si}`), btn('🧺 انتخاب‌ها', 'lkB')]);
    return present('links', mid, `📺 ${sr.name} · فصل ${fa(s)}`, kb(...rows));
  }
  async function files() {
    const b = basket(); const l = await lib(); const out = [];
    for (const name of b.m) { const mv = l.m.find((x) => x.name === name); if (!mv) continue; for (const f of mv.files) { out.push({ path: f.src, arc: `${mv.name}/${f.name}` }); for (const s of f.subs) out.push({ path: s.src, arc: `${mv.name}/${s.name}`, sub: true }); } }
    for (const [sn, srcs] of Object.entries(b.e)) {
      const sr = l.s.find((x) => x.name === sn); if (!sr) continue;
      for (const e of sr.eps) { if (!srcs.includes(e.src)) continue; const dir = `${sr.name}/${e.rel || `Season ${String(e.s).padStart(2, '0')}`}`; out.push({ path: e.src, arc: `${dir}/${e.name}` }); for (const s of e.subs) out.push({ path: s.src, arc: `${dir}/${s.name}`, sub: true }); }
    }
    return out;
  }
  async function title() {
    const b = basket(); const se = Object.entries(b.e).filter(([, v]) => v.length);
    const l = await lib();
    if (b.m.length === 1 && !se.length) return b.m[0];
    if (!b.m.length && se.length === 1) {
      const sr = l.s.find((x) => x.name === se[0][0]); const pick = sr ? sr.eps.filter((e) => se[0][1].includes(e.src)) : []; const ss = [...new Set(pick.map((e) => e.s))];
      return `${se[0][0]}${ss.length === 1 ? ` - Season ${ss[0]}` : ''}${sr && ss.length === 1 && pick.length < sr.eps.filter((e) => e.s === ss[0]).length ? ` (${se[0][1].length} ep)` : ''}`;
    }
    return `${b.m.length + se.length} items`;
  }
  async function formatView(mid) {
    const sm = await summary(); const b = basket();
    const fl = await files(); const vids = fl.filter((f) => !f.sub);
    b.fmt = b.fmt || 'zip'; store.save();
    const rows = [[btn(`${b.fmt === 'zip' ? '🔘' : '⚪️'} ZIP (پیشنهادی)`, 'lkf:zip'), ...(SET.on('features.links_rar') ? [btn(`${b.fmt === 'rar' ? '🔘' : '⚪️'} RAR`, 'lkf:rar')] : [])]];
    if (vids.length === 1) rows.push([btn(`${b.fmt === 'file' ? '🔘' : '⚪️'} فایل تکی (بدون آرشیو)`, 'lkf:file')]);
    rows.push([btn('➡️ مدت اعتبار', 'lkX')], [btn('↩️ انتخاب‌ها', 'lkB')]);
    return present('links', mid, `📦 قالب دانلود\n${fa(sm.n)} ویدیو${fl.length > vids.length ? ` + ${fa(fl.length - vids.length)} زیرنویس` : ''} · ${U.bytes(sm.size)}\n\n🗜 ZIP: همان لحظه آماده است، فشرده‌سازی ندارد (ویدیو فشرده‌تر نمی‌شود)، دانلود نیمه‌کاره ادامه پیدا می‌کند.\n📦 RAR: اول روی سرور ساخته می‌شود (به اندازه‌ی حجم فایل‌ها جا می‌گیرد) و وقتی آماده شد خبرت می‌کنم.`, kb(...rows));
  }
  async function expiryView(mid) {
    const b = basket();
    const rows = [[btn('۱ ساعت', 'lkx:h1'), btn('۱ روز', 'lkx:d1'), btn('۱ هفته', 'lkx:w1')], [btn('۱ ماه', 'lkx:m1'), btn('♾ بدون انقضا', 'lkx:never')], [btn('📅 تاریخ دلخواه', 'lkx:custom')], [btn('↩️ قالب', 'lkF')]];
    return present('links', mid, `⏳ مدت اعتبار لینک؟\n(قالب: ${b.fmt === 'rar' ? 'RAR' : b.fmt === 'file' ? 'فایل تکی' : 'ZIP'})`, kb(...rows));
  }
  async function maxView(mid) {
    const b = basket();
    return present('links', mid, `🔢 حداکثر دفعات دانلود؟\nاعتبار: ${b.expires ? `تا ${U.jalali(b.expires)} ساعت ${U.hhmm(b.expires)}` : 'بدون انقضا'}`,
      kb([btn('♾ نامحدود', 'lkn:0'), btn('۱ بار', 'lkn:1'), btn('۳ بار', 'lkn:3'), btn('۱۰ بار', 'lkn:10')], [btn('↩️ مدت اعتبار', 'lkX')]));
  }
  function linkText(l) {
    const u = L.urls(l.token);
    const st = L.state(l);
    const lines = [`🔗 ${l.title}`, '', `${ST[st] || st} · ${l.kind === 'rar' ? '📦 RAR' : l.kind === 'file' ? '📄 فایل تکی' : '🗜 ZIP'} · ${fa(l.items.length)} فایل · ${U.bytes(l.total)}`,
      `⏳ ${l.expires ? `تا ${U.jalali(l.expires)} ساعت ${U.hhmm(l.expires)}` : 'بدون انقضا'} · ⬇️ ${fa(l.downloads)}${l.max_dl ? ` از ${fa(l.max_dl)}` : ''} دانلود`];
    if (l.kind === 'rar') { const p = L.rarProgress(l.token) || {}; lines.push(`📦 RAR: ${{ queued: '⏸ در صف ساخت', building: `⚙️ در حال ساخت ${fa(p.pct || 0)}٪`, ready: `✅ آماده (${U.bytes(l.rar_size)})`, failed: `❌ ساخت نشد: ${l.rar_err || ''}`, deleted: '🗑 پاک شد' }[l.rar_status] || l.rar_status}`); }
    if (st === 'active') lines.push('', `🌐 بیرون:\n${u.public}`, '', `🏠 شبکه‌ی داخلی:\n${u.lan}`, '', `📄 صفحه‌ی فایل‌ها (دانلود تکی):\n${u.page}`);
    if (l.last_dl) lines.push('', `آخرین دانلود: ${U.ago(l.last_dl)}`);
    return lines.join('\n');
  }
  async function create(cb, mid) {
    const b = basket(); const fl = await files();
    if (!fl.length) return bale.answer(cb.id, 'چیزی انتخاب نشده', true);
    const l = await L.create({ uid: uid(), kind: b.fmt || 'zip', title: await title(), files: b.fmt === 'file' ? fl.filter((f) => !f.sub).slice(0, 1) : fl, expires: b.expires ?? null, maxDl: b.maxDl || null });
    P.audit(uid(), 'links', 'create', `${l.kind} ${l.items.length} files ${l.total} exp=${l.expires || '-'} max=${l.max_dl || '-'}`);
    d.lkw = null; store.save();
    await bale.answer(cb.id, '✅ لینک ساخته شد');
    return present('links', mid, linkText(l), kb([btn('⛔ لغو لینک', `lkR:${l.token.slice(0, 12)}`)], [btn('📋 لینک‌ها', 'lkM:0'), btn('✖️ بستن', 'close')]));
  }
  const byPrefix = (pre) => { const r = L.list({ all: true, limit: 500 }).find((x) => x.token.startsWith(pre)); return r && (P.isOwner(uid()) || r.creator === uid()) ? r : null; };
  async function mine(mid, page) {
    const arr = L.list({ uid: P.isOwner(uid()) ? null : uid(), all: true, limit: 200 }).filter((l) => L.state(l) === 'active' || Date.now() - l.created < 7 * 86400000);
    const pages = Math.max(1, Math.ceil(arr.length / PAGE)); page = Math.max(0, Math.min(page, pages - 1));
    const rows = arr.slice(page * PAGE, (page + 1) * PAGE).map((l) => [btn(`${(ST[L.state(l)] || '').split(' ')[0]} ${short(l.title, 24)} · ⬇️${fa(l.downloads)}`, `lkV:${l.token.slice(0, 12)}`)]);
    if (pages > 1) rows.push([btn('◀️', `lkM:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `lkM:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([btn('➕ لینک جدید', 'lkN'), btn('↩️ بازگشت', 'lk')]);
    return present('links', mid, arr.length ? `📋 لینک‌ها (${fa(arr.length)})` : 'هنوز لینکی نساخته‌ای.', kb(...rows));
  }
  async function view(mid, pre) {
    const l = byPrefix(pre); if (!l) return mine(mid, 0);
    const st = L.state(l);
    const rows = [];
    if (st === 'active') rows.push([btn('⛔ لغو لینک', `lkR:${pre}`), btn('⏳ +۱ هفته', `lkW:${pre}`)]);
    else if (st === 'expired') rows.push([btn('⏳ تمدید ۱ هفته', `lkW:${pre}`)]);
    if (l.kind === 'rar' && l.rar_status === 'failed' && st === 'active') rows.push([btn('🔁 ساخت دوباره‌ی RAR', `lkB2:${pre}`)]);
    rows.push([btn('🔄', `lkV:${pre}`), btn('↩️ لینک‌ها', 'lkM:0')]);
    return present('links', mid, linkText(l), kb(...rows));
  }
  // single file from the server browser
  async function forFile(mid, absPath, name) {
    d.lkw = { m: [], e: {}, t: Date.now(), single: { path: absPath, arc: name }, fmt: 'file' }; store.save();
    return expiryView(mid);
  }
  async function onText(aw, text) {
    const t = W.parseWhen(text);
    if (!t) return bale.send('⚠️ تاریخ را نفهمیدم. مثال: 1405/09/10 یا 1405/09/10 18:00 یا 2026-12-01 یا 3d یا «۲ هفته» (باید در آینده باشد).');
    basket().expires = t; store.save();
    return maxView(null);
  }

  // RAR ready / failed -> tell the creator
  const OB = require('./outbox');
  OB.register('rar_ready', async ({ token }) => { const l = L.get(token); if (!l || L.state(l) !== 'active') return null; return { text: `✅ فایل RAR آماده است\n\n${linkText(l)}` }; });
  L.ev.on('rarReady', (l) => { if (l) OB.enqueue(l.creator || P.owner(), 'rar_ready', { token: l.token }, `rar_ready:${l.token}:${l.rar_size || 0}`); });
  L.ev.on('rarFailed', (l) => { if (l) OB.enqueue(l.creator || P.owner(), 'text', { text: `❌ ساخت RAR برای «${l.title}» انجام نشد: ${l.rar_err || ''}\nلینک ZIP همیشه بدون ساخت قبلی کار می‌کند.` }, `rar_failed:${l.token}:${Date.now()}`); });

  async function onCallback(cb, a, p) {
    const mid = cb.message.message_id;
    const b = d.lkw;
    switch (a) {
      case 'lk': await bale.answer(cb.id); return menu(mid);
      case 'lkN': await bale.answer(cb.id); d.lkw = { m: [], e: {}, t: Date.now() }; store.save(); return pickRoot(mid);
      case 'lkB': await bale.answer(cb.id); return pickRoot(mid);
      case 'lkZ': await bale.answer(cb.id, 'خالی شد'); d.lkw = { m: [], e: {}, t: Date.now() }; store.save(); return pickRoot(mid);
      case 'lkm': await bale.answer(cb.id); return listView(mid, 'm', Number(p[0]) || 0);
      case 'lks': await bale.answer(cb.id); return listView(mid, 's', Number(p[0]) || 0);
      case 'lkt': { const bb = basket(); const n = bb.names && bb.names[Number(p[0])]; if (n) bb.m = bb.m.includes(n) ? bb.m.filter((x) => x !== n) : [...bb.m, n]; store.save(); await bale.answer(cb.id); return listView(mid, 'm', bb.page || 0); }
      case 'lkS': await bale.answer(cb.id); return seriesView(mid, Number(p[0]));
      case 'lkA': {
        const bb = basket(); const l = await lib(); const sr = l.s.find((x) => x.name === bb.names[bb.si]); if (!sr) break;
        const s = Number(p[0]); const idx = sr.eps.map((e, i) => (e.s === s ? i : -1)).filter((i) => i >= 0);
        const ids = idx.map((i) => sr.eps[i].src); const cur = bb.e[sr.name] || []; const all = ids.every((x) => cur.includes(x));
        bb.e[sr.name] = all ? cur.filter((x) => !ids.includes(x)) : [...new Set([...cur, ...ids])]; store.save();
        await bale.answer(cb.id); return seriesView(mid, bb.si);
      }
      case 'lkE': await bale.answer(cb.id); return epsView(mid, Number(p[0]), Number(p[1]) || 0);
      case 'lke': {
        const bb = basket(); const l = await lib(); const sr = l.s.find((x) => x.name === bb.names[bb.si]); if (!sr) break;
        const ep = sr.eps[Number(p[0])]; if (!ep) break; const cur = bb.e[sr.name] || []; bb.e[sr.name] = cur.includes(ep.src) ? cur.filter((x) => x !== ep.src) : [...cur, ep.src]; store.save();
        await bale.answer(cb.id); return epsView(mid, bb.season, bb.epage || 0);
      }
      case 'lkF': await bale.answer(cb.id); if (b && b.single) return expiryView(mid); return formatView(mid);
      case 'lkf': { const bb = basket(); bb.fmt = p[0] === 'rar' && !SET.on('features.links_rar') ? 'zip' : p[0]; store.save(); await bale.answer(cb.id); return formatView(mid); }
      case 'lkX': await bale.answer(cb.id); return expiryView(mid);
      case 'lkx': {
        await bale.answer(cb.id);
        if (p[0] === 'custom') { d.await = { type: 'link_date', until: Date.now() + 300000 }; store.save(); return bale.send('📅 تاریخ انقضا را بفرست: مثلاً 1405/09/10 یا 1405/09/10 18:00 یا 2026-12-01 یا 3d یا «۲ هفته».'); }
        basket().expires = W.fromPreset(p[0]); store.save(); return maxView(mid);
      }
      case 'lkn': {
        const bb = basket(); bb.maxDl = Number(p[0]) || null; store.save();
        if (bb.single) {
          const l = await L.create({ uid: uid(), kind: 'file', title: bb.single.arc, files: [bb.single], expires: bb.expires ?? null, maxDl: bb.maxDl });
          P.audit(uid(), 'links', 'create', `file 1 ${l.total}`); d.lkw = null; store.save();
          await bale.answer(cb.id, '✅ لینک ساخته شد');
          return present('links', mid, linkText(l), kb([btn('⛔ لغو لینک', `lkR:${l.token.slice(0, 12)}`)], [btn('📋 لینک‌ها', 'lkM:0'), btn('✖️ بستن', 'close')]));
        }
        return create(cb, mid);
      }
      case 'lkM': await bale.answer(cb.id); return mine(mid, Number(p[0]) || 0);
      case 'lkV': await bale.answer(cb.id); return view(mid, p[0]);
      case 'lkR': { const l = byPrefix(p[0]); if (!l) break; L.revoke(l.token, uid()); P.audit(uid(), 'links', 'revoke', l.title); await bale.answer(cb.id, '⛔ لغو شد'); return view(mid, p[0]); }
      case 'lkW': { const l = byPrefix(p[0]); if (!l) break; L.extend(l.token, Math.max(Date.now(), l.expires || Date.now()) + 7 * 86400000); P.audit(uid(), 'links', 'extend', l.title); await bale.answer(cb.id, '⏳ تمدید شد'); return view(mid, p[0]); }
      case 'lkB2': { const l = byPrefix(p[0]); if (!l) break; L.rebuildRar(l.token); await bale.answer(cb.id, '🔁 در صف ساخت'); return view(mid, p[0]); }
      default: break;
    }
    return bale.answer(cb.id);
  }
  return { onCallback, onText, menu, forFile };
};
