'use strict';
// Webhook receiver (Radarr/Sonarr) and background watcher (failures, subtitles, health, service outages).
const http = require('http');
const M = require('./media');
const V = require('./views');
const U = require('./util');
const { radarr, sonarr, prowlarr, bazarr, qbit, jellyfin } = require('./clients');
const C = require('./config');
const { HOOK_KEY, PORT } = C;
const { fan } = require('./fan');

module.exports = function createNotify(bale, store, ui) {
  const d = store.d;
  const { btn, kb } = V;
  const startedAt = Date.now();
  let healthFn = () => true;
  // media notices go to the owner + users holding 'notify'; health/outage alerts stay owner-only
  const nb = { send: (...a) => fan('notify', () => bale.send(...a)) };

  const seen = (key, ttl = 3 * 86400000) => { if (d.notified[key] && Date.now() - d.notified[key] < ttl) return true; d.notified[key] = Date.now(); store.save(); return false; };
  const epRange = (eps) => {
    eps = (eps || []).slice().sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
    if (!eps.length) return '';
    if (eps.length === 1) return U.sxe(eps[0].seasonNumber, eps[0].episodeNumber);
    const seasons = [...new Set(eps.map((e) => e.seasonNumber))];
    return seasons.length === 1 ? `فصل ${seasons[0]} · ${eps.length} قسمت` : `${eps.length} قسمت`;
  };
  function itemOf(ev) {
    const src = ev.movie || ev.series;
    if (!src) return null;
    const imgs = src.images || [];
    const p = imgs.find((i) => i.coverType === 'poster') || {};
    const remote = [p.remoteUrl, p.url].find((u) => u && /^https?:/.test(u)) || '';
    const local = [p.url].find((u) => u && u.startsWith('/')) || '';
    return ev.movie
      ? { k: 'm', title: src.title, year: src.year, tmdbId: src.tmdbId, imdbId: src.imdbId, libId: src.id, poster: remote, local: local.split('?')[0] }
      : { k: 's', title: src.title, year: src.year, tvdbId: src.tvdbId, imdbId: src.imdbId, libId: src.id, poster: remote, local: local.split('?')[0] };
  }
  const titleLine = (it, extra) => `${it.k === 'm' ? '🎬' : '📺'} ${it.title}${it.year && it.k === 'm' ? ` (${it.year})` : ''}${extra ? ` · ${extra}` : ''}`;
  const qualityOf = (ev) => {
    const f = ev.movieFile || ev.episodeFile || (ev.episodeFiles || [])[0];
    const q = (f && f.quality) || (ev.release && ev.release.quality);
    return typeof q === 'string' ? q : (q && q.quality && q.quality.name) || '';
  };

  async function sendNote(it, text, markup) {
    try { await fan('notify', () => ui.putCard(it, text, markup, null)); }
    catch (e) { U.log('error', 'notify failed: ' + e.message); }
  }

  // --- grab
  function onGrab(ev) {
    const it = itemOf(ev); if (!it) return;
    const key = `grab:${ev.downloadId || it.title + (ev.episodes || []).length}`;
    if (seen(key, 600000)) return;
    const rel = ev.release || {};
    const l = ['📥 شروع دانلود', '', titleLine(it, it.k === 's' ? epRange(ev.episodes) : '')];
    const bits = [rel.quality, rel.size ? U.bytes(rel.size) : ''].filter(Boolean);
    if (bits.length) l.push(`🎞 ${bits.join(' · ')}`);
    if (rel.indexer) l.push(`🌐 ${String(rel.indexer).replace(/\s*\(Prowlarr\)/, '')}`);
    if (rel.releaseTitle) l.push(`📝 ${U.trunc(rel.releaseTitle, 70)}`);
    return sendNote(it, l.join('\n'), kb([btn('📥 دانلودها', 'st')]));
  }

  // --- import (ready to watch)
  const pendingSeries = new Map();
  async function readyCard(it, extraLine, q, size) {
    let link = { url: C.JELLYFIN_PUBLIC, deep: false };
    try {
      jellyfin.refresh().catch(() => {});
      for (let i = 0; i < 6; i++) {
        await U.sleep(i === 0 ? 8000 : 10000);
        link = await M.jfLink(it.k, it);
        if (link.deep) break;
      }
    } catch {}
    const l = ['✅ آماده‌ی تماشاست', '', titleLine(it, extraLine)];
    const bits = [q, size ? U.bytes(size) : ''].filter(Boolean);
    if (bits.length) l.push(`🎞 ${bits.join(' · ')}`);
    l.push('💬 زیرنویس فارسی در صورت وجود خودکار اضافه می‌شود.');
    return sendNote(it, l.join('\n'), kb([V.url('▶️ پخش در Jellyfin', link.url)], [btn('📂 مدیریت', `li:${it.k}:${it.libId}`)]));
  }
  function onImport(ev) {
    if (ev.isUpgrade) return;
    const it = itemOf(ev); if (!it) return;
    if (it.k === 'm') {
      if (seen(`imp:m${it.libId}:${ev.movieFile && ev.movieFile.id}`, 3600000)) return;
      return readyCard(it, '', qualityOf(ev), ev.movieFile && ev.movieFile.size);
    }
    const p = pendingSeries.get(it.libId) || { it, eps: [], q: '', size: 0 };
    p.eps.push(...(ev.episodes || [])); p.q = qualityOf(ev) || p.q;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { pendingSeries.delete(it.libId); readyCard(it, epRange(p.eps), p.q, 0); }, 90000);
    pendingSeries.set(it.libId, p);
  }

  // --- health & manual interaction
  function onHealth(ev, restored) {
    const src = ev.instanceName || (ev.movie ? 'Radarr' : 'Sonarr');
    const key = `health:${src}:${ev.message}`;
    if (restored) { if (d.notified[key]) { delete d.notified[key]; store.save(); return bale.send(`✅ مشکل ${src} برطرف شد:\n${U.trunc(ev.message, 200)}`).catch(() => {}); } return; }
    if (seen(key, 6 * 3600000)) return;
    return bale.send(`⚠️ هشدار سلامت ${src}\n\n${U.trunc(ev.message, 300)}`, kb([btn('⚙️ وضعیت سرور', 'srv')])).catch(() => {});
  }
  function onManual(ev) {
    const it = itemOf(ev);
    const info = ev.downloadInfo || {};
    if (seen(`manual:${ev.downloadId || info.title}`, 6 * 3600000)) return;
    const msgs = (info.statusMessages || []).flatMap((m) => m.messages || [m.title]).filter(Boolean).slice(0, 2).map((x) => `⚠️ ${U.trunc(x, 140)}`);
    const text = ['🖐 نیاز به بررسی دستی', '', it ? titleLine(it) : U.trunc(info.title || '', 80), ...msgs].join('\n');
    return it ? sendNote(it, text, kb([btn('📥 دانلودها', 'st')])) : nb.send(text, kb([btn('📥 دانلودها', 'st')])).catch(() => {});
  }

  // notification types can be switched off at runtime (setting notify.types)
  const typeOn = (kind) => { try { return require('./settings').list('notify.types').includes(kind); } catch { return true; } };
  const KIND = { Grab: 'grab', Download: 'import', Health: 'health', HealthIssue: 'health', HealthRestored: 'health', ManualInteractionRequired: 'manual' };
  function onArrEvent(ev) {
    const t = String(ev && ev.eventType || '');
    if (KIND[t] && !typeOn(KIND[t])) return;
    try {
      if (t === 'Grab') return onGrab(ev);
      if (t === 'Download') return onImport(ev);
      if (t === 'Health' || t === 'HealthIssue') return onHealth(ev, false);
      if (t === 'HealthRestored') return onHealth(ev, true);
      if (t === 'ManualInteractionRequired') return onManual(ev);
    } catch (e) { U.log('error', 'hook handling failed: ' + e.message); }
  }

  // optional: Bazarr via Apprise json:// (title + message)
  function onBazarr(body) {
    const msg = [body && body.title, body && body.message].filter(Boolean).join('\n');
    if (!msg || seen('bz:' + msg, 600000)) return;
    return nb.send(`💬 ${U.trunc(msg, 300)}`).catch(() => {});
  }

  function startServer() {
    http.createServer((req, res) => {
      const path = req.url.split('?')[0];
      if ((path === '/rpc' || path === '/events') && require('./core').rpcHandler(req, res)) return;
      if (req.method === 'GET' && path === '/health') { const ok = healthFn(); res.statusCode = ok ? 200 : 503; res.end(ok ? 'ok' : 'stale'); return; }
      const m = path.match(/^\/hook\/([^/]+)(\/bazarr)?$/);
      if (req.method !== 'POST' || !HOOK_KEY || !m || m[1] !== HOOK_KEY) { res.statusCode = 404; res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        res.end('ok');
        try { const j = JSON.parse(body); if (m[2]) onBazarr(j); else onArrEvent(j); } catch (e) { U.log('warn', 'hook parse: ' + e.message); }
      });
    }).listen(PORT, () => U.log('info', `webhook server listening on ${PORT}`));
  }

  // ---------- watcher ----------
  const w = () => (d.watch = d.watch || {});
  const downCount = {};
  async function watchFailures() {
    if (!typeOn('failed')) return;
    for (const [k, arr, extra, label] of [['m', radarr, 'includeMovie=true', 'rf'], ['s', sonarr, 'includeSeries=true&includeEpisode=true', 'sf']]) {
      const h = await arr.get(`/history?page=1&pageSize=25&sortKey=date&sortDirection=descending&${extra}`, { tries: 1 });
      const recs = h.records || [];
      const maxId = recs.reduce((a, r) => Math.max(a, r.id), 0);
      if (w()[label] == null) { w()[label] = maxId; continue; } // baseline on first run
      const groups = new Map();
      for (const r of recs.filter((x) => x.id > w()[label] && x.eventType === 'downloadFailed')) {
        const g = groups.get(r.downloadId || r.id) || { r, eps: [] };
        if (r.episode) g.eps.push(r.episode);
        groups.set(r.downloadId || r.id, g);
      }
      w()[label] = Math.max(w()[label], maxId); store.save();
      for (const { r, eps } of groups.values()) {
        const src = r.movie || r.series; if (!src) continue;
        const it = k === 'm' ? { k, title: src.title, year: src.year, libId: src.id, poster: '', local: '' } : { k, title: src.title, libId: src.id, poster: '', local: '' };
        const reason = (r.data && r.data.message) || '';
        const text = ['❌ دانلود ناموفق بود', '', titleLine(it, k === 's' ? epRange(eps) : ''), reason ? `⚠️ ${U.trunc(reason, 160)}` : '', r.sourceTitle ? `📝 ${U.trunc(r.sourceTitle, 70)}` : '', '', 'ربات به‌صورت خودکار نسخه‌ی دیگری را امتحان می‌کند. اگر نشد، خودت نسخه‌ی دیگری انتخاب کن.'].filter((x) => x !== '').join('\n');
        await nb.send(text, kb([btn('🔀 انتخاب نسخه‌ی دیگر', `lrl:${k}:${src.id}`), btn('📥 دانلودها', 'st')])).catch(() => {});
      }
    }
  }
  async function watchSubtitles() {
    if (!typeOn('subtitle')) return;
    for (const [path, tag] of [['/movies/history', 'bm'], ['/episodes/history', 'be']]) {
      const r = await bazarr.get(`${path}?start=0&length=15`, { tries: 1 });
      const rows = (r && r.data) || [];
      const ts = (x) => Number(x.raw_timestamp) || Date.parse(x.timestamp) / 1000 || 0;
      const max = rows.reduce((a, x) => Math.max(a, ts(x)), 0);
      if (w()[tag] == null) { w()[tag] = max; continue; }
      const fresh = rows.filter((x) => ts(x) > w()[tag] && [1, 2, 3, 5].includes(Number(x.action)));
      w()[tag] = Math.max(w()[tag], max); store.save();
      const groups = new Map();
      for (const x of fresh) {
        const lang = typeof x.language === 'object' && x.language ? (x.language.name || x.language.code2) : x.language;
        const title = tag === 'bm' ? x.title : `${x.seriesTitle || ''}`;
        const g = groups.get(title + lang) || { title, lang, n: 0, ep: x.episode_number };
        g.n++; groups.set(title + lang, g);
      }
      for (const g of groups.values()) {
        const fa = /persian|farsi|fa/i.test(String(g.lang));
        await nb.send(`💬 زیرنویس ${fa ? 'فارسی' : g.lang} اضافه شد\n\n${tag === 'bm' ? '🎬' : '📺'} ${g.title}${tag === 'be' ? (g.n > 1 ? ` · ${g.n} قسمت` : g.ep ? ` · ${g.ep}` : '') : ''}`).catch(() => {});
      }
    }
  }
  async function watchHealth() {
    for (const [src, arr] of [['Radarr', radarr], ['Sonarr', sonarr], ['Prowlarr', prowlarr]]) {
      const list = await arr.get('/health', { tries: 1 }).catch(() => null);
      if (!list) continue;
      const now = new Set(list.map((h) => `health:${src}:${h.message}`));
      if (!typeOn('health')) continue;
      for (const h of list) if (h.type === 'error' || h.type === 'warning') onHealth({ instanceName: src, message: h.message }, false);
      for (const k of Object.keys(d.notified)) if (k.startsWith(`health:${src}:`) && !now.has(k)) onHealth({ instanceName: src, message: k.slice(`health:${src}:`.length) }, true);
    }
  }
  async function watchServices() {
    const checks = [['Radarr', () => radarr.ping()], ['Sonarr', () => sonarr.ping()], ['Prowlarr', () => prowlarr.ping()], ['qBittorrent', () => qbit.version()], ['Jellyfin', () => jellyfin.ping()], ['Bazarr', () => bazarr.get('/system/status', { tries: 1 })]];
    for (const [name, fn] of checks) {
      let ok = true; try { await fn(); } catch { ok = false; }
      const s = (d.watch.svc = d.watch.svc || {});
      if (ok) {
        if (s[name] && s[name].alerted && typeOn('outage')) await bale.send(`✅ ${name} دوباره در دسترس است.`).catch(() => {});
        s[name] = { fails: 0, alerted: false };
      } else {
        const c = (s[name] = s[name] || { fails: 0, alerted: false });
        c.fails++;
        if (c.fails >= 4 && !c.alerted && Date.now() - startedAt > 300000) { c.alerted = true; if (typeOn('outage')) await bale.send(`❌ ${name} در دسترس نیست (چند دقیقه است).\nداکر معمولاً خودش دوباره بالا می‌آورد. اگر درست نشد سرور را چک کن.`, kb([btn('⚙️ وضعیت سرور', 'srv')])).catch(() => {}); }
      }
    }
    store.save();
  }
  function startWatcher() {
    const safe = (fn, name) => fn().catch((e) => U.log('warn', `watcher ${name}: ${e.message}`));
    let n = 0;
    const tick = async () => {
      n++;
      await safe(watchFailures, 'failures');
      await safe(watchSubtitles, 'subtitles');
      await safe(watchServices, 'services');
      if (n % 5 === 1) await safe(watchHealth, 'health');
    };
    setTimeout(() => { tick(); setInterval(tick, 60000); }, 25000);
  }

  return { startServer, startWatcher, setHealth: (f) => { healthFn = f; }, onArrEvent };
};
