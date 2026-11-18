'use strict';
// Data layer: everything that talks to Radarr/Sonarr/Prowlarr/Bazarr/qBittorrent/Jellyfin.
const fs = require('fs');
const os = require('os');
const { radarr, sonarr, prowlarr, bazarr, qbit, jellyfin } = require('./clients');
const C = require('./config');
const { POSTER_PROXY } = C;
const U = require('./util');

const arrOf = (k) => (k === 'm' ? radarr : sonarr);

// ---------- normalisation ----------
const img = (o, type) => (o.images || []).find((i) => i.coverType === type) || {};
function normMovie(o) {
  const r = o.ratings || {};
  const p = img(o, 'poster');
  return {
    k: 'm', key: o.tmdbId, ref: 'm' + o.tmdbId, title: o.title, year: o.year || 0,
    overview: U.trunc(o.overview, 600), genres: o.genres || [],
    imdb: (r.imdb && r.imdb.value) || null, tmdb: (r.tmdb && r.tmdb.value) || null, rt: (r.rottenTomatoes && r.rottenTomatoes.value) || null,
    runtime: o.runtime || 0, studio: o.studio || '', status: o.status || '', cert: o.certification || '',
    poster: o.remotePoster || p.remoteUrl || '', local: o.id && p.url ? p.url.split('?')[0] : '',
    libId: o.id || 0, hasFile: !!o.hasFile, size: o.sizeOnDisk || 0, imdbId: o.imdbId || '', tmdbId: o.tmdbId,
  };
}
function normSeries(o) {
  const p = img(o, 'poster');
  const st = o.statistics || {};
  const seasons = (o.seasons || []).map((s) => s.seasonNumber).filter((n) => n > 0).sort((a, b) => a - b);
  return {
    k: 's', key: o.tvdbId, ref: 's' + o.tvdbId, title: o.title, year: o.year || 0,
    overview: U.trunc(o.overview, 600), genres: o.genres || [],
    rating: (o.ratings && o.ratings.value) || null, runtime: o.runtime || 0, network: o.network || '', status: o.status || '',
    seasonCount: st.seasonCount || seasons.length, seasons, cert: o.certification || '',
    poster: o.remotePoster || p.remoteUrl || '', local: o.id && p.url ? p.url.split('?')[0] : '',
    libId: o.id || 0, eps: st.episodeFileCount || 0, epTotal: st.episodeCount || st.totalEpisodeCount || 0, size: st.sizeOnDisk || 0,
    imdbId: o.imdbId || '', tvdbId: o.tvdbId, tmdbId: o.tmdbId || 0,
  };
}
const norm = (k, o) => (k === 'm' ? normMovie(o) : normSeries(o));

// ---------- search ----------
async function lookup(k, term) {
  const path = k === 'm' ? '/movie/lookup' : '/series/lookup';
  const list = await arrOf(k).get(`${path}?term=${encodeURIComponent(term)}`, { timeout: 70000 });
  return (Array.isArray(list) ? list : []).filter((o) => (k === 'm' ? o.tmdbId : o.tvdbId));
}
async function search(term, kind) {
  const jobs = [];
  if (kind !== 'tv') jobs.push(lookup('m', term).then((l) => ['m', l]).catch((e) => ['m', null, e]));
  if (kind !== 'movie') jobs.push(lookup('s', term).then((l) => ['s', l]).catch((e) => ['s', null, e]));
  const res = await Promise.all(jobs);
  const errors = res.filter((r) => r[2]).map((r) => ({ k: r[0], e: r[2] }));
  const per = kind === 'all' ? 6 : 10;
  const lists = res.filter((r) => r[1]).map(([k, l]) => l.slice(0, per).map((o) => norm(k, o)));
  // interleave movies and series, exact title matches first
  const out = [];
  for (let i = 0; i < per; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  const t = term.trim().toLowerCase();
  out.sort((a, b) => (b.title.toLowerCase() === t) - (a.title.toLowerCase() === t));
  return { items: out, errors };
}
async function fresh(k, key) {
  const term = k === 'm' ? `tmdb:${key}` : `tvdb:${key}`;
  const l = await lookup(k, term);
  if (!l.length) throw new Error('نتیجه پیدا نشد');
  return l[0];
}

// ---------- quality profiles / adding ----------
const QUALITIES = {
  m: [
    { k: '1080', label: '🎞 1080p', re: /^HD-1080p$/i },
    { k: '4k', label: '🌟 4K', re: /^Ultra-HD$/i },
    { k: '10b', label: '💎 بهترین کیفیت (10bit)', re: /10\s*bit/i },
  ],
  s: [
    { k: '1080', label: '🎞 1080p', re: /^HD-1080p$/i },
    { k: 'hd', label: '📺 720p یا 1080p', re: /720p\s*\/\s*1080p/i },
    { k: '4k', label: '🌟 4K', re: /^Ultra-HD$/i },
    { k: '10b', label: '💎 بهترین کیفیت (10bit)', re: /10\s*bit/i },
  ],
};
async function qualityOptions(k) {
  const profiles = await arrOf(k).get('/qualityprofile');
  return QUALITIES[k].map((q) => ({ ...q, profile: profiles.find((p) => q.re.test(p.name)) })).filter((q) => q.profile)
    .map((q) => ({ k: q.k, label: q.label, id: q.profile.id, name: q.profile.name }));
}
async function rootFolder(k) {
  let want = k === 'm' ? '/data/media/movies' : '/data/media/tv';
  try { const v = require('./settings').get(k === 'm' ? 'requests.root_m' : 'requests.root_s'); if (v) want = String(v).replace(/\/$/, ''); } catch {}
  const rf = await arrOf(k).get('/rootfolder');
  return (rf.find((r) => r.path.replace(/\/$/, '') === want) || rf[0] || { path: want }).path;
}

async function addMovie(key, qk) {
  const o = await fresh('m', key);
  if (o.id) return { already: true, item: normMovie(o) };
  const q = (await qualityOptions('m')).find((x) => x.k === qk) || (await qualityOptions('m'))[0];
  const body = { ...o, qualityProfileId: q.id, rootFolderPath: await rootFolder('m'), monitored: true, minimumAvailability: 'released', addOptions: { monitor: 'movieOnly', searchForMovie: true } };
  const res = await radarr.post('/movie', body);
  return { item: normMovie(res), quality: q.name, id: res.id };
}

async function addSeries(key, { mode, seasons = [], qk }) {
  const o = await fresh('s', key);
  if (o.id) return { already: true, item: normSeries(o) };
  const opts = await qualityOptions('s');
  const q = opts.find((x) => x.k === qk) || opts[0];
  const body = { ...o, qualityProfileId: q.id, rootFolderPath: await rootFolder('s'), monitored: true, seasonFolder: true, seriesType: 'standard',
    addOptions: { monitor: 'all', searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false } };
  if (mode === 'last') body.addOptions.monitor = 'lastSeason';
  else if (mode === 'fut') body.addOptions.monitor = 'future';
  else if (mode === 'sel') {
    body.seasons = (o.seasons || []).map((s) => ({ ...s, monitored: seasons.includes(s.seasonNumber) }));
    body.addOptions = { monitor: 'unknown', ignoreEpisodesWithFiles: false, ignoreEpisodesWithoutFiles: false, searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false };
  }
  const res = await sonarr.post('/series', body);
  if (mode === 'sel') await fixSelection(res.id, seasons).catch((e) => U.log('warn', 'fixSelection: ' + e.message));
  return { item: normSeries(res), quality: q.name, id: res.id };
}
// Safety net: make sure only the chosen seasons are monitored and searched
async function fixSelection(seriesId, seasons) {
  await U.sleep(1500);
  const eps = await sonarr.get(`/episode?seriesId=${seriesId}`);
  const want = eps.filter((e) => seasons.includes(e.seasonNumber) && !e.monitored && !e.hasFile).map((e) => e.id);
  const unwant = eps.filter((e) => !seasons.includes(e.seasonNumber) && e.monitored).map((e) => e.id);
  if (want.length) await sonarr.put('/episode/monitor', { episodeIds: want, monitored: true });
  if (unwant.length) await sonarr.put('/episode/monitor', { episodeIds: unwant, monitored: false });
  if (want.length) for (const s of seasons) await sonarr.post('/command', { name: 'SeasonSearch', seriesId, seasonNumber: s }).catch(() => {});
}

// ---------- library ----------
async function libraryList(k) {
  const l = await arrOf(k).get(k === 'm' ? '/movie' : '/series');
  return l.map((o) => norm(k, o)).sort((a, b) => a.title.localeCompare(b.title));
}
function isDone(it) { return it.k === 'm' ? it.hasFile : (it.epTotal > 0 && it.eps >= it.epTotal); }
async function libObj(k, id) { return arrOf(k).get(k === 'm' ? `/movie/${id}` : `/series/${id}`); }

async function subtitles(k, id) {
  try {
    const d = k === 'm' ? await bazarr.get(`/movies?radarrid%5B%5D=${id}`) : await bazarr.get(`/series?seriesid%5B%5D=${id}`);
    const r = d && d.data && d.data[0];
    if (!r) return null;
    if (k === 'm') {
      return { have: (r.subtitles || []).map((s) => s.name || s.code2).filter(Boolean), missing: (r.missing_subtitles || []).map((s) => s.name || s.code2).filter(Boolean) };
    }
    return { epHave: (r.episodeFileCount || 0) - (r.episodeMissingCount || 0), epMissing: r.episodeMissingCount || 0, epTotal: r.episodeFileCount || 0 };
  } catch { return null; }
}

async function jfLink(k, item) {
  try {
    const id = await jellyfin.find(k, item);
    if (id) return { url: `${C.JELLYFIN_PUBLIC}/web/#/details?id=${id}`, deep: true };
  } catch (e) { U.log('warn', 'jellyfin find: ' + e.message); }
  return { url: C.JELLYFIN_PUBLIC, deep: false };
}

async function researchItem(k, id, season) {
  if (k === 'm') return radarr.post('/command', { name: 'MoviesSearch', movieIds: [Number(id)] });
  if (season != null) return sonarr.post('/command', { name: 'SeasonSearch', seriesId: Number(id), seasonNumber: Number(season) });
  return sonarr.post('/command', { name: 'SeriesSearch', seriesId: Number(id) });
}
async function deleteItem(k, id, files) {
  return arrOf(k).del(`${k === 'm' ? '/movie' : '/series'}/${id}?deleteFiles=${files ? 'true' : 'false'}&addImportExclusion=false`);
}

// ---------- interactive release search ----------
async function releases(k, id, season) {
  const path = k === 'm' ? `/release?movieId=${id}` : `/release?seriesId=${id}${season != null ? `&seasonNumber=${season}` : ''}`;
  const l = await arrOf(k).get(path, { timeout: 150000, tries: 1 });
  return (Array.isArray(l) ? l : [])
    .filter((r) => r.protocol !== 'torrent' || (r.seeders || 0) > 0)
    .map((r) => ({
      guid: r.guid, indexerId: r.indexerId, title: r.title, size: r.size, seeders: r.seeders || 0, leechers: r.leechers || 0,
      quality: (r.quality && r.quality.quality && r.quality.quality.name) || '?', indexer: String(r.indexer || '').replace(/\s*\(Prowlarr\)/, ''),
      age: r.age, rejected: !!r.rejected, why: (r.rejections || [])[0] || '', pack: !!r.fullSeason,
    }))
    .sort((a, b) => (a.rejected - b.rejected) || (b.seeders - a.seeders));
}
async function grab(k, rel) {
  return arrOf(k).post('/release', { guid: rel.guid, indexerId: rel.indexerId }, { timeout: 60000 });
}

// ---------- downloads ----------
const QB_STATE = {
  downloading: 'در حال دانلود', forcedDL: 'در حال دانلود', stalledDL: 'منتظر سیدر', metaDL: 'دریافت اطلاعات تورنت', forcedMetaDL: 'دریافت اطلاعات تورنت',
  pausedDL: 'متوقف‌شده', stoppedDL: 'متوقف‌شده', queuedDL: 'در صف', checkingDL: 'بررسی فایل‌ها', checkingUP: 'بررسی فایل‌ها',
  checkingResumeData: 'بررسی فایل‌ها', allocating: 'تخصیص فضا', moving: 'جابه‌جایی فایل',
  uploading: 'تکمیل شد، در حال ایمپورت', stalledUP: 'تکمیل شد، در حال ایمپورت', pausedUP: 'تکمیل شد', stoppedUP: 'تکمیل شد',
  forcedUP: 'تکمیل شد', queuedUP: 'تکمیل شد', error: 'خطا', missingFiles: 'فایل‌ها پیدا نشد',
};
const ARR_STATE = { downloading: 'در حال دانلود', queued: 'در صف', paused: 'متوقف‌شده', completed: 'تکمیل شد، در حال ایمپورت', warning: 'هشدار', failed: 'ناموفق', delay: 'در انتظار', importPending: 'در انتظار ایمپورت', importing: 'در حال ایمپورت', downloadClientUnavailable: 'کلاینت در دسترس نیست' };

async function downloads() {
  const [rq, sq, qb, tr] = await Promise.allSettled([
    radarr.get('/queue?page=1&pageSize=100&includeMovie=true'),
    sonarr.get('/queue?page=1&pageSize=300&includeSeries=true&includeEpisode=true'),
    qbit.torrents(), qbit.transfer(),
  ]);
  const tor = new Map();
  if (qb.status === 'fulfilled') for (const t of qb.value) tor.set(t.hash.toLowerCase(), t);
  const groups = new Map();
  const add = (k, r) => {
    const id = (r.downloadId || `${k}-${r.id}`).toLowerCase();
    if (!groups.has(id)) groups.set(id, { id, k, hash: r.downloadId ? id : null, recs: [] });
    groups.get(id).recs.push(r);
  };
  if (rq.status === 'fulfilled') for (const r of rq.value.records || []) add('m', r);
  if (sq.status === 'fulfilled') for (const r of sq.value.records || []) add('s', r);
  const items = [];
  for (const g of groups.values()) {
    const r0 = g.recs[0];
    const t = g.hash ? tor.get(g.hash) : null;
    let progress;
    if (t) progress = t.progress * 100;
    else { const tot = r0.size || 0; progress = tot ? (1 - (r0.sizeleft || 0) / tot) * 100 : 0; }
    const it = { id: g.id, k: g.k, hash: g.hash, qids: g.recs.map((r) => r.id), progress, warnings: [] };
    if (g.k === 'm') {
      it.name = r0.movie ? `${r0.movie.title}${r0.movie.year ? ` (${r0.movie.year})` : ''}` : r0.title;
      it.libId = r0.movieId; it.sub = '';
    } else {
      it.name = r0.series ? r0.series.title : r0.title;
      it.libId = r0.seriesId;
      const eps = g.recs.map((r) => r.episode).filter(Boolean);
      const seasons = [...new Set(g.recs.map((r) => r.seasonNumber).filter((x) => x != null))];
      it.season = seasons.length === 1 ? seasons[0] : null;
      if (g.recs.length === 1 && eps[0]) it.sub = U.sxe(eps[0].seasonNumber, eps[0].episodeNumber);
      else if (seasons.length === 1) it.sub = `فصل ${seasons[0]} (${g.recs.length} قسمت)`;
      else it.sub = `${g.recs.length} قسمت`;
    }
    if (t) {
      Object.assign(it, { speed: t.dlspeed, eta: t.eta >= 8640000 ? null : t.eta, seeds: t.num_seeds, peers: t.num_leechs, size: t.size, state: QB_STATE[t.state] || t.state, paused: /^(paused|stopped)/.test(t.state), up: t.upspeed });
    } else {
      it.size = r0.size || 0; it.state = ARR_STATE[r0.status] || r0.status; it.paused = r0.status === 'paused';
      it.etaText = r0.timeleft || null;
    }
    for (const r of g.recs) {
      if (r.errorMessage) it.warnings.push(r.errorMessage);
      for (const m of r.statusMessages || []) it.warnings.push(...(m.messages || [m.title]).filter(Boolean));
    }
    it.warnings = [...new Set(it.warnings)].slice(0, 2);
    items.push(it);
  }
  items.sort((a, b) => (b.speed || 0) - (a.speed || 0) || a.name.localeCompare(b.name));
  const errors = [rq, sq].filter((x) => x.status === 'rejected').map((x) => x.reason.message);
  return { items, transfer: tr.status === 'fulfilled' ? tr.value : null, errors };
}

async function removeDownload(it, blocklist) {
  const arr = arrOf(it.k);
  try {
    await arr.del(`/queue/bulk?removeFromClient=true&blocklist=${blocklist ? 'true' : 'false'}`, { ids: it.qids });
  } catch (e) {
    for (const id of it.qids) await arr.del(`/queue/${id}?removeFromClient=true&blocklist=${blocklist ? 'true' : 'false'}`).catch(() => {});
  }
}
async function findDownload(hash12) {
  const d = await downloads();
  return d.items.find((i) => i.hash && i.hash.startsWith(hash12));
}

// ---------- calendar / recent ----------
async function calendar(days) {
  const start = U.ymd(Date.now()), end = U.ymd(Date.now() + days * 86400000);
  const [s, m] = await Promise.allSettled([
    sonarr.get(`/calendar?start=${start}&end=${end}&includeSeries=true&unmonitored=false`),
    radarr.get(`/calendar?start=${start}&end=${end}&unmonitored=false`),
  ]);
  const days_ = new Map();
  const put = (when, line) => { const key = U.ymd(when); if (!days_.has(key)) days_.set(key, { when, lines: [] }); days_.get(key).lines.push({ t: new Date(when).getTime(), line }); };
  if (s.status === 'fulfilled') {
    const grouped = new Map();
    for (const e of s.value) {
      if (!e.airDateUtc) continue;
      const gk = `${e.seriesId}-${U.ymd(e.airDateUtc)}`;
      if (!grouped.has(gk)) grouped.set(gk, []);
      grouped.get(gk).push(e);
    }
    for (const eps of grouped.values()) {
      const e0 = eps[0];
      const nums = eps.length === 1 ? U.sxe(e0.seasonNumber, e0.episodeNumber) : `${U.sxe(e0.seasonNumber, e0.episodeNumber)} تا ${U.sxe(eps[eps.length - 1].seasonNumber, eps[eps.length - 1].episodeNumber)}`;
      const done = eps.every((e) => e.hasFile) ? ' ✅' : '';
      put(e0.airDateUtc, `📺 ${e0.series ? e0.series.title : 'سریال'} · ${nums} · ${U.hhmm(e0.airDateUtc)}${done}`);
    }
  }
  if (m.status === 'fulfilled') {
    for (const o of m.value) {
      for (const [f, label] of [['inCinemas', 'سینما'], ['digitalRelease', 'انتشار دیجیتال'], ['physicalRelease', 'انتشار فیزیکی']]) {
        if (o[f] && U.ymd(o[f]) >= start && U.ymd(o[f]) <= end) put(o[f], `🎬 ${o.title} (${label})${o.hasFile ? ' ✅' : ''}`);
      }
    }
  }
  const out = [...days_.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => ({ when: v.when, lines: v.lines.sort((a, b) => a.t - b.t).map((x) => x.line) }));
  return { days: out, errors: [s, m].filter((x) => x.status === 'rejected').length };
}

async function recent() {
  const q = 'page=1&pageSize=40&sortKey=date&sortDirection=descending';
  const [rh, sh, ml, sl] = await Promise.allSettled([
    radarr.get(`/history?${q}&includeMovie=true`), sonarr.get(`/history?${q}&includeSeries=true&includeEpisode=true`),
    radarr.get('/movie'), sonarr.get('/series'),
  ]);
  const imported = [];
  if (rh.status === 'fulfilled') for (const r of rh.value.records || []) if (r.eventType === 'downloadFolderImported' && r.movie) imported.push({ date: r.date, k: 'm', id: r.movie.id, title: `${r.movie.title} (${r.movie.year})` });
  const sg = new Map();
  if (sh.status === 'fulfilled') for (const r of sh.value.records || []) {
    if (r.eventType !== 'downloadFolderImported' || !r.series) continue;
    const key = `${r.seriesId}-${U.ymd(r.date)}`;
    if (!sg.has(key)) sg.set(key, { date: r.date, k: 's', id: r.seriesId, title: r.series.title, eps: [] });
    if (r.episode) sg.get(key).eps.push(U.sxe(r.episode.seasonNumber, r.episode.episodeNumber));
  }
  for (const g of sg.values()) { g.eps.sort(); imported.push({ date: g.date, k: 's', id: g.id, title: `${g.title} · ${g.eps.length === 1 ? g.eps[0] : g.eps.length + ' قسمت'}` }); }
  imported.sort((a, b) => new Date(b.date) - new Date(a.date));
  const added = [];
  if (ml.status === 'fulfilled') for (const o of ml.value) added.push({ date: o.added, k: 'm', id: o.id, title: `${o.title} (${o.year})`, done: o.hasFile });
  if (sl.status === 'fulfilled') for (const o of sl.value) added.push({ date: o.added, k: 's', id: o.id, title: o.title, done: o.statistics && o.statistics.episodeCount > 0 && o.statistics.episodeFileCount >= o.statistics.episodeCount });
  added.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { imported: imported.slice(0, 8), added: added.slice(0, 6) };
}

// ---------- server ----------
async function timed(fn) { const t = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, err: e.message }; } }
async function server() {
  const [pr, ps, pp, pq, pj, pb, rh, sh, ph, pi, pst, ds, tr] = await Promise.all([
    timed(() => radarr.ping()), timed(() => sonarr.ping()), timed(() => prowlarr.ping()), timed(() => qbit.version()),
    timed(() => jellyfin.ping()), timed(() => bazarr.get('/system/status', { tries: 1 })),
    radarr.get('/health', { tries: 1 }).catch(() => []), sonarr.get('/health', { tries: 1 }).catch(() => []), prowlarr.get('/health', { tries: 1 }).catch(() => []),
    prowlarr.get('/indexer', { tries: 1 }).catch(() => []), prowlarr.get('/indexerstatus', { tries: 1 }).catch(() => []),
    radarr.get('/diskspace', { tries: 1 }).catch(() => []), qbit.transfer().catch(() => null),
  ]);
  const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const mem = {};
  for (const l of rd('/proc/meminfo').split('\n')) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mem[m[1]] = Number(m[2]) * 1024; }
  const load = rd('/proc/loadavg').split(' ').slice(0, 3).map(Number);
  const up = Number(rd('/proc/uptime').split(' ')[0]);
  const disk = ds.find((d) => d.path === '/data') || ds[0];
  const statuses = new Map(pst.map((s) => [s.indexerId, s]));
  const idx = pi.map((i) => ({ name: i.name, enable: i.enable, st: statuses.get(i.id) }));
  const warnings = [...rh.map((h) => ({ src: 'Radarr', m: h.message, type: h.type })), ...sh.map((h) => ({ src: 'Sonarr', m: h.message, type: h.type })), ...ph.map((h) => ({ src: 'Prowlarr', m: h.message, type: h.type }))];
  return {
    services: [['Radarr', pr], ['Sonarr', ps], ['Prowlarr', pp], ['qBittorrent', pq], ['Jellyfin', pj], ['Bazarr', pb]],
    mem: { total: mem.MemTotal || 0, avail: mem.MemAvailable || 0 }, load, cores: os.cpus().length, up, disk, tr, idx, warnings,
  };
}

// ---------- posters ----------
const posterCache = new Map();
async function grabImage(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    const jpg = b[0] === 0xff && b[1] === 0xd8, png = b[0] === 0x89 && b[1] === 0x50;
    return b.length > 1500 && b.length < 8e6 && (jpg || png) ? b : null;
  } catch { return null; }
}
async function posterBuffer(item) {
  const key = item.poster || item.local;
  if (!key) return null;
  if (posterCache.has(key)) return posterCache.get(key);
  let buf = null;
  if (item.poster) {
    const u = item.poster.replace('/original/', '/w500/');
    buf = await grabImage(POSTER_PROXY + encodeURIComponent(u)) || (!/image\.tmdb\.org/.test(u) ? await grabImage(u) : null);
  }
  if (!buf && item.local && item.libId) {
    const arr = arrOf(item.k);
    buf = await grabImage(arr.http.base.replace(/\/api\/v\d$/, '') + item.local, arr.http.headers);
  }
  if (buf) { posterCache.set(key, buf); if (posterCache.size > 40) posterCache.delete(posterCache.keys().next().value); }
  return buf;
}

module.exports = {
  norm, normMovie, normSeries, search, fresh, qualityOptions, addMovie, addSeries, libraryList, isDone, libObj, subtitles, jfLink,
  researchItem, deleteItem, releases, grab, downloads, removeDownload, findDownload, calendar, recent, server, posterBuffer, grabImage, arrOf,
};
