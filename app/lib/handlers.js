'use strict';
// Conversation logic: menu, search cards, download flows, library, downloads, calendar, server status,
// plus routing to the USB / import / server-files / links / access-control UIs. Every update runs in a
// per-user context (ctx) and every command, menu button, text prompt and callback is checked against
// the user's permissions here, server-side.
const M = require('./media');
const V = require('./views');
const U = require('./util');
const { MENU } = require('./config');
const { radarr, sonarr, qbit } = require('./clients');
const createUsb = require('./usbui');
const createJobsUi = require('./jobsui');
const createImportUi = require('./importui');
const createFilesUi = require('./filesui');
const createLinksUi = require('./linksui');
const createAclUi = require('./aclui');
const P = require('./perms');
const ctx = require('./ctx');

module.exports = function createHandlers(bale, store) {
  const d = store.d;
  const { btn, kb } = V;

  const userErr = (e) => {
    U.log('warn', 'handler error: ' + e.message);
    if (e.net || e.status >= 502) return `⚠️ اتصال به ${e.svc || 'سرویس'} برقرار نشد. چند لحظه‌ی دیگر دوباره امتحان کن.`;
    return `⚠️ ${U.trunc(U.redact(e.message), 250)}`;
  };
  const pickFileId = (m) => (m && Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1].file_id : null);

  // ---------- presentation helpers ----------
  async function putCard(item, cap, markup, kind) {
    const prev = kind ? d.last[kind] : null;
    let msg = null;
    const key = item.poster || item.local;
    if (key && d.posterFiles[key]) {
      try { msg = await bale.sendPhoto(d.posterFiles[key], cap, markup); } catch { delete d.posterFiles[key]; }
    }
    if (!msg && key) {
      bale.action('upload_photo');
      const buf = await M.posterBuffer(item);
      if (buf) {
        try { msg = await bale.sendPhoto(buf, cap, markup); const f = pickFileId(msg); if (f) d.posterFiles[key] = f; }
        catch (e) { U.log('warn', 'sendPhoto failed: ' + e.message); }
      }
    }
    if (!msg) msg = await bale.send(cap, markup);
    if (kind) { d.last[kind] = msg.message_id; }
    store.save();
    if (prev && prev !== msg.message_id) bale.del(prev);
    return msg;
  }
  // Show a text view: edit in place when the tapped message is the current view of this kind, otherwise send fresh
  async function present(kind, cbMsgId, text, markup) {
    if (cbMsgId && d.last[kind] === cbMsgId && !bale.isPhoto(cbMsgId)) {
      try { await bale.editText(cbMsgId, text, markup); return { message_id: cbMsgId }; } catch (e) { U.log('warn', 'present edit: ' + e.message); }
    }
    const prev = d.last[kind];
    const msg = await bale.send(text, markup);
    d.last[kind] = msg.message_id; store.save();
    if (prev && prev !== msg.message_id) bale.del(prev);
    return msg;
  }

  const pres = (...a) => present(...a);
  const jobsui = createJobsUi(bale, store);
  const imp = createImportUi(bale, store, pres);
  const links = createLinksUi(bale, store, pres);
  const files = createFilesUi(bale, store, pres, { linkForFile: (mid, abs, name) => links.forFile(mid, abs, name) });
  const acl = createAclUi(bale, store, pres);
  const usb = createUsb(bale, store, pres, { importCb: (cb, a, p) => imp.onCallback(cb, a, p), jobsCb: (cb, a, p) => jobsui.onCallback(cb, a, p) });
  const me = () => ctx.uid() || bale.owner;
  const perms = () => P.permsOf(me());
  const can = (perm) => perm === 'any' ? P.allowed(me()) : perms().has(perm);
  const NOPERM = '⛔ این بخش برای شما فعال نیست.';

  // ---------- search ----------
  async function promptSearch() {
    await present('prompt', null, '🔎 اسم فیلم یا سریال را بفرست.\nانگلیسی یا فارسی، اسم کامل یا بخشی از آن. یا همین‌جا نوعش را مشخص کن:', kb([btn('🎬 فقط فیلم', 'sk:m'), btn('📺 فقط سریال', 'sk:s')], [btn('✖️ بستن', 'close')]));
  }
  async function doSearch(term, kind) {
    const wait = await bale.send(`🔎 در حال جست‌وجوی «${U.trunc(term, 40)}»...\nچند ثانیه صبر کن.`);
    try {
      const res = await bale.withAction('typing', () => M.search(term, kind));
      if (!res.items.length) {
        if (res.errors.length) throw res.errors[0].e;
        await bale.editText(wait.message_id, `چیزی برای «${U.trunc(term, 40)}» پیدا نشد 🤔\nاسم را انگلیسی یا دقیق‌تر امتحان کن.`);
        return;
      }
      const sid = U.shortId();
      d.searches[sid] = { t: Date.now(), term, refs: res.items.map((i) => i.ref) };
      for (const it of res.items) d.objs[it.ref] = it;
      store.save();
      await showSearchCard(sid, 0);
      bale.del(wait.message_id);
    } catch (e) { await bale.editText(wait.message_id, userErr(e)).catch(() => {}); }
  }
  async function showSearchCard(sid, idx) {
    const s = d.searches[sid];
    if (!s) return bale.send('این نتیجه‌ها منقضی شده‌اند. دوباره جست‌وجو کن.');
    const it = d.objs[s.refs[idx]];
    return putCard(it, V.caption(it), V.searchKb(it, sid, idx, s.refs.length), 'search');
  }
  function cardView(ref) {
    const it = d.objs[ref]; const ctx = d.flows[ref] && d.flows[ref].ctx;
    const s = ctx && d.searches[ctx.sid];
    return { text: V.caption(it), markup: s ? V.searchKb(it, ctx.sid, Number(ctx.idx), s.refs.length) : kb([btn('✖️ بستن', 'close')]) };
  }

  // ---------- download flow ----------
  const flow = (ref) => (d.flows[ref] = d.flows[ref] || { t: Date.now() });
  async function stepQuality(mid, ref) {
    const it = d.objs[ref];
    const opts = await M.qualityOptions(it.k);
    const back = it.k === 'm' ? `x:${ref}` : (flow(ref).mode === 'sel' ? `mo:${ref}:sel` : `a:${ref}`);
    return bale.edit(mid, `${V.headline(it)}${it.k === 's' ? `\n📚 ${V.modeText(flow(ref), it)}` : ''}\n\n🎞 کیفیت دانلود را انتخاب کن:`, V.qualityKb(it, opts, back));
  }
  async function onFlow(cb, a, p) {
    const mid = cb.message.message_id;
    const ref = p[0];
    const it = d.objs[ref];
    if (!it) return bale.answer(cb.id, 'این مورد منقضی شده، دوباره جست‌وجو کن', true);
    const f = flow(ref);
    if (a === 'x') { await bale.answer(cb.id); const v = cardView(ref); return bale.edit(mid, v.text, v.markup); }
    if (a === 'a') {
      await bale.answer(cb.id);
      if (p[1]) { const [sid, idx] = p[1].split('.'); f.ctx = { sid, idx }; store.save(); }
      if (it.k === 'm') return stepQuality(mid, ref);
      return bale.edit(mid, `${V.headline(it)}\n\n📚 کدام فصل‌ها دانلود شوند؟`, V.modeKb(it));
    }
    if (a === 'mo') {
      await bale.answer(cb.id);
      const mode = p[1];
      if (mode === 'q') return stepQuality(mid, ref);
      f.mode = mode;
      if (mode === 'sel') { f.seasons = f.seasons || []; store.save(); return bale.edit(mid, `${V.headline(it)}\n\n☑️ فصل‌ها را انتخاب کن (${f.seasons.length} انتخاب‌شده):`, V.seasonKb(it, f.seasons)); }
      store.save(); return stepQuality(mid, ref);
    }
    if (a === 't' || a === 'ts') {
      f.seasons = f.seasons || [];
      if (a === 't') { const n = Number(p[1]); f.seasons = f.seasons.includes(n) ? f.seasons.filter((x) => x !== n) : [...f.seasons, n]; }
      else if (p[1] === 'all') f.seasons = [...it.seasons];
      else if (p[1] === 'none') f.seasons = [];
      else if (p[1] === 'ok') {
        if (!f.seasons.length) return bale.answer(cb.id, 'حداقل یک فصل را انتخاب کن', true);
        await bale.answer(cb.id); store.save(); return stepQuality(mid, ref);
      }
      await bale.answer(cb.id); store.save();
      return bale.edit(mid, `${V.headline(it)}\n\n☑️ فصل‌ها را انتخاب کن (${f.seasons.length} انتخاب‌شده):`, V.seasonKb(it, f.seasons));
    }
    if (a === 'q') {
      await bale.answer(cb.id);
      f.q = p[1]; store.save();
      const opt = (await M.qualityOptions(it.k)).find((o) => o.k === f.q);
      return bale.edit(mid, V.confirmText(it, f, opt), V.confirmKb(it));
    }
    if (a === 'y') {
      await bale.answer(cb.id, '⏳ در حال افزودن...');
      await bale.edit(mid, `⏳ در حال افزودن «${it.title}» به کتابخانه...`, kb());
      try {
        const r = it.k === 'm' ? await M.addMovie(it.key, f.q) : await M.addSeries(it.key, { mode: f.mode || 'all', seasons: f.seasons || [], qk: f.q });
        if (r.already) { d.objs[ref] = { ...d.objs[ref], libId: r.item.libId }; store.save(); return bale.edit(mid, `«${it.title}» از قبل در کتابخانه است.`, kb([btn('📂 مدیریت در کتابخانه', `li:${it.k}:${r.item.libId}`)])); }
        d.objs[ref] = { ...d.objs[ref], libId: r.id }; delete d.flows[ref]; store.save();
        const t = [`✅ به کتابخانه اضافه شد`, '', V.headline(it)];
        if (it.k === 's') t.push(`📚 ${V.modeText(f, it)}`);
        t.push(`🎞 کیفیت: ${r.quality}`, '', '🔎 جست‌وجوی بهترین نسخه شروع شد. وقتی دانلود شروع شود و وقتی آماده تماشا شود خبرت می‌کنم.');
        return bale.edit(mid, t.join('\n'), kb([btn('📥 دانلودها', 'st'), btn('📂 کتابخانه', `li:${it.k}:${r.id}`)]));
      } catch (e) {
        const v = cardView(ref);
        return bale.edit(mid, `${userErr(e)}\n\n${v.text}`.slice(0, 1000), v.markup);
      }
    }
  }

  // ---------- library ----------
  const profileCache = {};
  async function profileName(k, id) {
    const c = profileCache[k];
    if (!c || Date.now() - c.t > 600000) profileCache[k] = { t: Date.now(), list: await M.arrOf(k).get('/qualityprofile').catch(() => []) };
    const p = profileCache[k].list.find((x) => x.id === id);
    return p ? `🎞 ${p.name}` : '';
  }
  function ctxLib() { return (d.libctx = d.libctx || { k: 'm', page: 0, filter: 'all', term: '' }); }
  async function libItems() {
    const c = ctxLib();
    let list = await M.libraryList(c.k);
    const total = list.length;
    if (c.filter === 'done') list = list.filter(M.isDone);
    if (c.filter === 'wait') list = list.filter((x) => !M.isDone(x));
    if (c.term) list = list.filter((x) => x.title.toLowerCase().includes(c.term.toLowerCase()));
    return { list, total };
  }
  async function showLibMenu(cbMsgId) {
    const [m, s] = await Promise.all([M.libraryList('m').catch(() => []), M.libraryList('s').catch(() => [])]);
    const done = m.filter(M.isDone).length;
    return present('lib', cbMsgId, `🎬 کتابخانه\n\nفیلم‌ها: ${m.length} (${done} آماده)\nسریال‌ها: ${s.length}\n\nچه چیزی را ببینیم؟`, V.libMenuKb());
  }
  async function showLibList(cbMsgId) {
    const { list, total } = await libItems();
    const c = ctxLib();
    const v = V.libListView(c, list, total);
    c.page = v.page; store.save();
    return present('lib', cbMsgId, v.text, v.kb);
  }
  async function libCardData(k, id) {
    const o = await M.libObj(k, id);
    const it = M.norm(k, o);
    const has = k === 'm' ? o.hasFile : (o.statistics && o.statistics.episodeFileCount > 0);
    const [bz, jf, dl, profile] = await Promise.all([
      M.subtitles(k, id), has ? M.jfLink(k, it) : { url: require('./config').JELLYFIN_PUBLIC, deep: false },
      M.downloads().then((r) => r.items.find((i) => i.k === k && String(i.libId) === String(id))).catch(() => null),
      profileName(k, o.qualityProfileId),
    ]);
    return { o, it, cap: V.libCaption(k, o, { bz, dl, profile }), markup: V.libKb(k, o, jf) };
  }
  async function showLibItem(k, id) {
    const c = await libCardData(k, id);
    return putCard(c.it, c.cap, c.markup, 'lib');
  }
  async function onLibrary(cb, a, p) {
    const mid = cb.message.message_id;
    if (a === 'lib') {
      const w = p[0];
      if (w === 'q') { await bale.answer(cb.id); d.await = { type: 'lib', until: Date.now() + 300000 }; store.save(); return bale.send('🔎 بخشی از اسم فیلم یا سریال را بفرست تا در کتابخانه پیدا کنم.'); }
      await bale.answer(cb.id);
      const c = ctxLib(); c.k = w; c.page = 0; c.term = ''; store.save();
      return showLibList(mid);
    }
    if (a === 'lp') {
      await bale.answer(cb.id);
      if (p[0] !== 'back') { ctxLib().page = Number(p[0]); store.save(); }
      return showLibList(bale.isPhoto(mid) ? null : mid);
    }
    if (a === 'lf') { await bale.answer(cb.id); const c = ctxLib(); c.filter = p[0]; c.page = 0; store.save(); return showLibList(mid); }
    if (a === 'li') { await bale.answer(cb.id, '⏳'); return showLibItem(p[0], p[1]); }
    if (a === 'lit') { await bale.answer(cb.id); const c = await libCardData(p[0], p[1]); return bale.edit(mid, c.cap, c.markup); }
    if (a === 'lr') { await bale.answer(cb.id, '🔎 جست‌وجو شروع شد. نتیجه را در دانلودها ببین'); return M.researchItem(p[0], p[1]); }
    if (a === 'lss') { await bale.answer(cb.id, `🔎 جست‌وجوی فصل ${p[1]} شروع شد`); return M.researchItem('s', p[0], p[1]); }
    if (a === 'lse') { await bale.answer(cb.id); const o = await M.libObj('s', p[0]); const v = V.seasonsView(o); return bale.edit(mid, v.text, v.markup || v.kb); }
    if (a === 'lx') { await bale.answer(cb.id); const o = await M.libObj(p[0], p[1]); return bale.edit(mid, V.delText(p[0], o), V.delKb(p[0], p[1])); }
    if (a === 'lxx') {
      await bale.answer(cb.id, '🗑 در حال حذف...');
      const o = await M.libObj(p[0], p[1]);
      await M.deleteItem(p[0], p[1], p[2] === '1');
      return bale.edit(mid, `🗑 «${o.title}» حذف شد${p[2] === '1' ? ' (همراه فایل‌ها)' : ''}.`, kb([btn('↩️ فهرست', 'lp:back')]));
    }
  }
  async function libSearch(term) {
    const c = ctxLib(); c.term = term; c.page = 0; c.filter = 'all';
    const [m, s] = await Promise.all([M.libraryList('m'), M.libraryList('s')]);
    const hit = (l) => l.some((x) => x.title.toLowerCase().includes(term.toLowerCase()));
    c.k = hit(m) || !hit(s) ? 'm' : 's'; store.save();
    return showLibList(null);
  }

  // ---------- interactive releases ----------
  async function releaseSearch(cb, k, id, season, replace) {
    const o = await M.libObj(k, id);
    const label = `${o.title}${season != null ? ` · فصل ${season}` : ''}`;
    const wait = await bale.send(`🔀 در حال جست‌وجوی نسخه‌های «${label}» در همه‌ی ایندکسرها...\nممکن است تا یک دقیقه طول بکشد.`);
    try {
      const list = await bale.withAction('typing', () => M.releases(k, id, season));
      if (!list.length) return bale.editText(wait.message_id, `نسخه‌ای با سیدر فعال برای «${label}» پیدا نشد.`, kb([btn('✖️ بستن', 'close')]));
      const rid = U.shortId();
      d.rels[rid] = { t: Date.now(), k, id, season: season ?? null, label, list: list.slice(0, 60), replace: replace || null };
      store.save();
      const prev = d.last.rel; d.last.rel = wait.message_id;
      if (prev && prev !== wait.message_id) bale.del(prev);
      return bale.editText(wait.message_id, V.relText(d.rels[rid], 0), V.relKb(rid, d.rels[rid], 0));
    } catch (e) { return bale.editText(wait.message_id, userErr(e), kb([btn('✖️ بستن', 'close')])).catch(() => {}); }
  }
  async function onRelease(cb, a, p) {
    const mid = cb.message.message_id;
    const rs = d.rels[p[0]];
    if (!rs) return bale.answer(cb.id, 'این فهرست منقضی شده، دوباره جست‌وجو کن', true);
    if (a === 'rel') { await bale.answer(cb.id); return bale.editText(mid, V.relText(rs, Number(p[1])), V.relKb(p[0], rs, Number(p[1]))); }
    // rg: grab
    await bale.answer(cb.id, '⏳ در حال ارسال به دانلود...');
    const rel = rs.list[Number(p[1])];
    try {
      await M.grab(rs.k, rel);
      let extra = '';
      if (rs.replace) { await M.removeDownload(rs.replace, true).then(() => { extra = '\n🗑 دانلود قبلی حذف شد.'; }).catch(() => { extra = '\n⚠️ دانلود قبلی را نتوانستم حذف کنم.'; }); }
      return bale.editText(mid, `✅ برای دانلود ارسال شد\n\n${rs.label}\n🎞 ${rel.quality} · ${U.bytes(rel.size)} · 👥 ${rel.seeders} سید${extra}`, kb([btn('📥 دانلودها', 'st'), btn('✖️ بستن', 'close')]));
    } catch (e) {
      const msg = /expired|not found|cache/i.test(e.message) ? 'این نسخه دیگر در حافظه نیست، فهرست را دوباره بگیر.' : userErr(e);
      return bale.editText(mid, `${msg}\n\n${V.relText(rs, Math.floor(Number(p[1]) / 6))}`.slice(0, 3900), V.relKb(p[0], rs, Math.floor(Number(p[1]) / 6)));
    }
  }

  // ---------- downloads (live) ----------
  const lives = new Map(); // chat -> live updater of the downloads view
  const curLive = () => lives.get(bale.chat) || null;
  function stopLive() { const l = curLive(); if (l) { clearInterval(l.timer); lives.delete(bale.chat); } }
  function stopAllLive() { for (const l of lives.values()) clearInterval(l.timer); lives.clear(); }
  async function renderDownloads() { const dd = await M.downloads(); return { dd, text: V.dlText(dd), markup: V.dlKb(dd) }; }
  function startLive(mid, hasItems) {
    stopLive();
    if (!hasItems) return;
    const lv = { mid, n: 0, busy: false };
    // the interval callback inherits this user's async context (ctx), so edits go to the right chat
    lv.timer = setInterval(async () => {
      if (lv.busy) return;
      lv.busy = true;
      try {
        if (!P.allowed(me())) { if (curLive() === lv) stopLive(); return; }
        if (++lv.n > 28) { if (curLive() === lv) stopLive(); await bale.editMarkup(mid, (await renderDownloads()).markup).catch(() => {}); return; }
        const v = await renderDownloads();
        if (curLive() !== lv) return;
        await bale.editText(mid, v.text, v.markup);
        if (!v.dd.items.length && curLive() === lv) stopLive();
      } catch (e) {
        if (e.code === 400 && /not found|can't be edited|deleted/i.test(e.message)) { if (curLive() === lv) stopLive(); }
      } finally { lv.busy = false; }
    }, 7000);
    lives.set(bale.chat, lv);
  }
  async function showDownloads(cbMsgId) {
    const v = await renderDownloads();
    const msg = await present('status', cbMsgId, v.text, v.markup);
    startLive(msg.message_id, v.dd.items.length > 0);
  }
  async function onDownload(cb, a, p) {
    const mid = cb.message.message_id;
    if (a === 'st') { await bale.answer(cb.id, '🔄'); return showDownloads(mid); }
    const [op, h, arg] = p;
    const it = await M.findDownload(h);
    if (!it) { await bale.answer(cb.id, 'این دانلود دیگر در صف نیست', true); return showDownloads(mid); }
    if (op === 'p' || op === 'r') {
      await bale.answer(cb.id, op === 'p' ? '⏸ متوقف شد' : '▶️ ادامه پیدا کرد');
      await qbit.action(op === 'p' ? 'pause' : 'resume', it.hash);
      await U.sleep(800);
      return showDownloads(mid);
    }
    if (op === 'x') { await bale.answer(cb.id); stopLive(); return bale.editText(mid, V.dlRemoveText(it), V.dlRemoveKb(it)); }
    if (op === 'xx') {
      await bale.answer(cb.id, '🗑 در حال حذف...');
      await M.removeDownload(it, arg === '1');
      await U.sleep(800);
      return showDownloads(mid);
    }
    if (op === 'a') {
      await bale.answer(cb.id, '🔀 جست‌وجوی نسخه‌ها...');
      return releaseSearch(cb, it.k, it.libId, it.k === 's' ? it.season : null, { k: it.k, qids: it.qids });
    }
  }

  // ---------- calendar / new / server ----------
  async function showCalendar(cbMsgId, days) {
    const c = await M.calendar(days);
    return present('cal', cbMsgId, V.calText(c, days), V.calKb(days));
  }
  async function showNew(cbMsgId) {
    const r = await M.recent();
    return present('new', cbMsgId, V.newText(r), V.newKb(r));
  }
  async function showServer(cbMsgId) {
    const s = await M.server();
    return present('srv', cbMsgId, V.srvText(s), V.srvKb());
  }
  async function showIndexers(cbMsgId) {
    const s = await M.server();
    return present('srv', cbMsgId, V.idxText(s), kb([btn('↩️ بازگشت', 'srv')], [btn('✖️ بستن', 'close')]));
  }

  // ---------- routing ----------
  const COMMANDS = [
    ['start', 'شروع و منوی اصلی'], ['status', 'دانلودها و پیشرفت'], ['library', 'کتابخانه'], ['new', 'تازه‌ها'],
    ['calendar', 'تقویم پخش'], ['server', 'وضعیت سرور'], ['usb', 'حافظه‌های خارجی (فلش و هارد)'], ['files', 'فایل‌های سرور'], ['links', 'لینک دانلود'],
    ['movie', 'جست‌وجوی فیلم'], ['tv', 'جست‌وجوی سریال'], ['help', 'راهنما'],
  ];
  const run = async (fn) => { try { return await fn(); } catch (e) { await bale.send(userErr(e)).catch(() => {}); } };
  const home = () => bale.send(V.helpFor(perms()), V.menuKb(perms()));
  // perm needed by a pending text prompt
  const AWAIT_PERM = { lib: 'library', movie: 'request', tv: 'request', usb_mkdir: 'usb_manage', usb_rename: 'usb_manage', imp_search: 'usb_import', link_date: 'links', acl_uid: 'admin', acl_date: 'admin' };
  const gate = (perm, fn) => () => (can(perm) ? fn() : bale.send(NOPERM));

  async function onMessage(m) {
    const text = (m.text || '').trim();
    if (!text) return;
    const menu = {
      [MENU.search]: gate('request', promptSearch), [MENU.dl]: gate('downloads', () => showDownloads(null)), [MENU.lib]: gate('library', () => showLibMenu(null)),
      [MENU.news]: gate('library', () => showNew(null)), [MENU.cal]: gate('calendar', () => showCalendar(null, 7)), [MENU.srv]: gate('server', () => showServer(null)),
      [MENU.help]: home, [MENU.usb]: gate('usb_view', () => usb.showDrives(null)), [MENU.usbOld]: gate('usb_view', () => usb.showDrives(null)),
      [MENU.files]: gate('files', () => files.roots(null)), [MENU.links]: gate('links', () => links.menu(null)), [MENU.acl]: gate('admin', () => acl.list(null)),
    };
    if (menu[text]) { d.await = null; return run(menu[text]); }
    const c = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (c) {
      const cmd = c[1].toLowerCase(), arg = c[2].trim();
      const cmds = {
        start: home, help: home, menu: () => bale.send('منوی اصلی 👇', V.menuKb(perms())),
        status: gate('downloads', () => showDownloads(null)), downloads: gate('downloads', () => showDownloads(null)), library: gate('library', () => showLibMenu(null)),
        new: gate('library', () => showNew(null)), calendar: gate('calendar', () => showCalendar(null, 7)), server: gate('server', () => showServer(null)),
        usb: gate('usb_view', () => usb.showDrives(null)), flash: gate('usb_view', () => usb.showDrives(null)), drives: gate('usb_view', () => usb.showDrives(null)),
        files: gate('files', () => files.roots(null)), links: gate('links', () => links.menu(null)), users: gate('admin', () => acl.list(null)), search: gate('request', promptSearch),
      };
      if (cmds[cmd]) { d.await = null; return run(cmds[cmd]); }
      if (cmd === 'movie' || cmd === 'tv') { if (!can('request')) return bale.send(NOPERM); return run(() => (arg ? doSearch(arg, cmd) : bale.send(`بعد از /${cmd} اسم را هم بنویس. مثلاً /${cmd} ${cmd === 'movie' ? 'The Pianist' : 'Breaking Bad'}`))); }
      return bale.send('این دستور را نمی‌شناسم. /help را بزن.');
    }
    const aw = d.await; d.await = null; store.save();
    if (aw && aw.until > Date.now()) {
      const need = AWAIT_PERM[aw.type] || 'admin';
      if (!can(need)) return bale.send(NOPERM);
      if (aw.type === 'lib') return run(() => libSearch(text));
      if (aw.type === 'movie' || aw.type === 'tv') return run(() => doSearch(text, aw.type));
      if (aw.type === 'usb_mkdir' || aw.type === 'usb_rename') return run(() => usb.onText(aw, text));
      if (aw.type === 'imp_search') return run(() => imp.onText(aw, text));
      if (aw.type === 'link_date') return run(() => links.onText(aw, text));
      if (aw.type === 'acl_uid' || aw.type === 'acl_date') return run(() => acl.onText(aw, text));
    }
    if (!can('request')) return can('library') ? run(() => libSearch(text)) : home();
    return run(() => doSearch(text, 'all'));
  }

  const recentTaps = new Map();
  async function onCallback(cb) {
    const data = cb.data || '';
    const key = `${bale.chat}:${cb.message && cb.message.message_id}:${data}`;
    if (recentTaps.has(key) && Date.now() - recentTaps.get(key) < 1200) return bale.answer(cb.id);
    recentTaps.set(key, Date.now());
    if (recentTaps.size > 200) recentTaps.delete(recentTaps.keys().next().value);
    if (!cb.message) return bale.answer(cb.id);
    const mid = cb.message.message_id;
    const [a, ...p] = data.split(':');
    const need = P.permFor(a);
    if (!can(need)) { P.audit(me(), need, 'denied', a); return bale.answer(cb.id, NOPERM, true); }
    try {
      if (a[0] === 'u') return await usb.onCallback(cb, a, p);
      if (a.startsWith('fs')) return await files.onCallback(cb, a, p);
      if (a.startsWith('lk')) return await links.onCallback(cb, a, p);
      if (a.startsWith('ac')) return await acl.onCallback(cb, a, p);
      switch (a) {
        case 'noop': return bale.answer(cb.id);
        case 'menu': await bale.answer(cb.id); return home();
        case 'close': await bale.answer(cb.id); if (curLive() && curLive().mid === mid) stopLive(); for (const k of Object.keys(d.last)) if (d.last[k] === mid) delete d.last[k]; return bale.del(mid);
        case 'n': await bale.answer(cb.id); return showSearchCard(p[0], Number(p[1]));
        case 'sk': await bale.answer(cb.id); d.await = { type: p[0] === 'm' ? 'movie' : 'tv', until: Date.now() + 300000 }; store.save(); return bale.editText(mid, p[0] === 'm' ? '🎬 اسم فیلم را بفرست.' : '📺 اسم سریال را بفرست.', kb([btn('✖️ بستن', 'close')]));
        case 'a': case 'mo': case 't': case 'ts': case 'q': case 'y': case 'x': return await onFlow(cb, a, p);
        case 'lib': case 'lp': case 'lf': case 'li': case 'lit': case 'lr': case 'lss': case 'lse': case 'lx': case 'lxx': return await onLibrary(cb, a, p);
        case 'lrl': await bale.answer(cb.id, '🔀 جست‌وجوی نسخه‌ها...'); return await releaseSearch(cb, p[0], p[1], p[2] != null ? Number(p[2]) : null, null);
        case 'rel': case 'rg': return await onRelease(cb, a, p);
        case 'st': case 'dq': return await onDownload(cb, a, p);
        case 'cal': await bale.answer(cb.id); return await showCalendar(mid, Number(p[0]));
        case 'new': await bale.answer(cb.id, '🔄'); return await showNew(mid);
        case 'srv': await bale.answer(cb.id, '🔄'); return await showServer(mid);
        case 'idx': await bale.answer(cb.id); return await showIndexers(mid);
        default: return bale.answer(cb.id);
      }
    } catch (e) {
      await bale.answer(cb.id, U.trunc(userErr(e), 150), true).catch(() => {});
      await bale.send(userErr(e)).catch(() => {});
    }
  }

  // Unknown users: only a one-time invite code is accepted (/start CODE, /join CODE or the bare code);
  // /start gets one short refusal (rate-limited per user), anything else is ignored. Nothing about the
  // bot, its owner or its content is revealed.
  const refused = new Map();
  async function stranger(u, from, chat) {
    const m = u.message;
    if (!m || !m.text) return;
    const t = m.text.trim();
    const mm = t.match(/^\/(?:start|join)(?:@\w+)?\s+([A-Za-z0-9_-]{8,20})$/) || t.match(/^([A-Za-z0-9_-]{12})$/);
    if (mm) {
      const user = P.redeem(mm[1], { uid: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null, username: from.username || null });
      if (user) {
        U.log('info', `invite redeemed by ${from.id}`);
        await ctx.run({ chat, uid: from.id }, () => bale.send(`✅ خوش آمدی! دسترسی شما فعال شد${user.expires ? ` (تا ${U.jalali(user.expires)})` : ''}.`).then(() => home()));
        ctx.run({ chat: bale.owner, uid: bale.owner }, () => bale.send(`👥 ${user.name || user.username || from.id} (${from.id}) با لینک دعوت وارد شد.\nمجوزها: ${user.perms.map((k) => P.LABEL[k]).join('، ')}`)).catch(() => {});
        return;
      }
    }
    if (/^\/start\b/.test(t)) {
      const last = refused.get(from.id) || 0;
      if (Date.now() - last < 3600000) return;
      refused.set(from.id, Date.now()); if (refused.size > 1000) refused.delete(refused.keys().next().value);
      P.audit(from.id, 'any', 'refused', mm ? 'bad invite' : '');
      const txt = require('./settings').get('acl.refusal_text'); if (txt) await ctx.run({ chat, uid: from.id }, () => bale.send(txt)).catch(() => {});
    }
  }

  async function onUpdate(u) {
    const msg = u.message || (u.callback_query && u.callback_query.message);
    const chatObj = msg && msg.chat;
    const from = u.message ? u.message.from : u.callback_query && u.callback_query.from;
    if (!chatObj || !from || !from.id) return;
    if (chatObj.type && chatObj.type !== 'private') return;   // private chats only
    if (Number(chatObj.id) !== Number(from.id)) return;
    const uid = Number(from.id);
    if (!P.allowed(uid)) return stranger(u, from, uid).catch((e) => U.log('warn', 'stranger: ' + e.message));
    P.touch(uid, [from.first_name, from.last_name].filter(Boolean).join(' ') || null, from.username || null);
    return ctx.run({ chat: uid, uid }, async () => {
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) { U.log('error', 'update failed: ' + e.message); }
    });
  }

  return { usb, jobsui, imp, links, files, acl, onUpdate, onMessage, onCallback, putCard, COMMANDS, showSearchCard, doSearch, showDownloads, showCalendar, showNew, showServer, showLibMenu, stopLive: stopAllLive, present, home };
};
