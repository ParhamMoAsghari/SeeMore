'use strict';
// Import from an external drive into the archive (service layer).
//  scan()   walk a drive folder, detect movies / episodes / subtitles / samples / other files, match them
//           with Radarr / Sonarr (their own lookup proxies; TMDB is not used directly) and find duplicates.
//  build()  turn a reviewed scan into a durable job (jobs.js kind 'import'): files are copied into
//           /data/usb-imports/.staging/<id>/ (same filesystem as the library) and verified first.
//  post()   idempotent post phase: add missing titles unmonitored (never searches), Radarr/Sonarr
//           ManualImport (importMode move, so naming/history stay consistent), fallback direct placement
//           + rescan, subtitles next to the final file, other files to /data/usb-imports/<drive>/<date>/,
//           Bazarr disk scan, Jellyfin refresh.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const U = require('./util');
const S = require('./usb');
const J = require('./jobs');
const META = require('./meta');
const { radarr, sonarr, bazarr, jellyfin } = require('./clients');

const IMPORT_ROOT = '/data/usb-imports';
const STAGING = path.join(IMPORT_ROOT, '.staging');
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv)$/i;
const SUBS = /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i;
const SYS_DIR = /^(System Volume Information|\$RECYCLE\.BIN|RECYCLER|lost\+found|\.Trash.*|\.Spotlight.*|\.fseventsd)$/i;
const EXTRAS_DIR = /^(extras?|featurettes?|behind[ ._-]?the[ ._-]?scenes|deleted[ ._-]?scenes|interviews?|trailers?|bonus|shorts|scenes|other)$/i;
const EXTRAS_NAME = /[-._ ](trailer|featurette|behindthescenes|deleted|interview|extra|teaser)$/i;
const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|web[ .-]?dl|webrip|web|bluray|blu-ray|bdrip|brrip|hdrip|dvdrip|dvdscr|hdtv|hdcam|cam|ts|10bit|8bit|hdr10?|dv|dolby|atmos|aac\d?|ac3|eac3|ddp?\d?|dts(-hd)?|truehd|flac|mp3|proper|repack|extended|unrated|remastered|internal|limited|multi|dual(?:[ .-]audio)?|farsi|persian|dubbed|dub|hardsub|softsub|subbed|nf|amzn|dsnp|hmax|atvp|yify|yts|rarbg|psa|pahe|ganool)\b/i;
const LANGS = { fa: ['fa', 'fas', 'per', 'persian', 'farsi', 'فارسی', 'parsi'], en: ['en', 'eng', 'english'], ar: ['ar', 'ara', 'arabic'], tr: ['tr', 'tur', 'turkish'],
  fr: ['fr', 'fre', 'fra', 'french'], de: ['de', 'ger', 'deu', 'german'], es: ['es', 'spa', 'spanish'], ru: ['ru', 'rus', 'russian'], it: ['it', 'ita', 'italian'],
  pt: ['pt', 'por', 'portuguese', 'brazilian'], ko: ['ko', 'kor', 'korean'], ja: ['ja', 'jpn', 'japanese'], zh: ['zh', 'chi', 'zho', 'chinese'], hi: ['hi', 'hin', 'hindi'] };
const LANG_OF = {}; for (const [k, arr] of Object.entries(LANGS)) for (const a of arr) LANG_OF[a] = k;
const LANG_FA = { fa: 'فارسی', en: 'انگلیسی', ar: 'عربی', tr: 'ترکی', fr: 'فرانسوی', de: 'آلمانی', es: 'اسپانیایی', ru: 'روسی', it: 'ایتالیایی', pt: 'پرتغالی', ko: 'کره‌ای', ja: 'ژاپنی', zh: 'چینی', hi: 'هندی' };

const faDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\u0600-\u06ff]+/g, '');
const stripExt = (n) => n.replace(/\.[^.]+$/, '');
function cleanTitle(raw) {
  let s = faDigits(raw).replace(/\[[^\]]*\]/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let year = null;
  const ym = s.match(/(?:^|[\s(])((?:19|20)\d\d)(?:[\s)]|$)/);
  if (ym && ym.index > 0) { year = Number(ym[1]); s = s.slice(0, ym.index); }
  const jm = s.match(JUNK); if (jm && jm.index > 0) s = s.slice(0, jm.index);
  s = s.replace(/\([^)]*\)/g, ' ').replace(/[-–\s]+$/g, '').replace(/^[-–\s]+/, '').replace(/\s+/g, ' ').trim();
  return { title: s, year };
}

// ---------- episode detection ----------
const SEASON_DIR = [/^(?:season|series|staffel|saison|temporada|s|فصل)[ ._-]*(\d{1,2})(?:\D|$)/i, /\bseason[ ._-]*(\d{1,2})\b/i, /\bS(\d{1,2})(?![\dE])/i, /فصل[ ._-]*(\d{1,2})/];
function seasonFromDirs(dirs) {
  for (let i = dirs.length - 1; i >= 0; i--) {
    const d = faDigits(dirs[i]);
    for (const re of SEASON_DIR) { const m = d.match(re); if (m) return { s: Number(m[1]), at: i }; }
  }
  return null;
}
function parseEpisode(name, dirs) {
  const n = faDigits(stripExt(name));
  let m = n.match(/S(\d{1,3})\s*[._-]?\s*E(\d{1,4})((?:\s*[-_.]?\s*E\d{1,4})*)/i);
  if (m) return { s: Number(m[1]), e: [Number(m[2]), ...[...(m[3] || '').matchAll(/E(\d{1,4})/gi)].map((x) => Number(x[1]))], at: m.index, how: 'SxxEyy' };
  m = n.match(/(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:[^\d]|$)/i);
  if (m) return { s: Number(m[1]), e: [Number(m[2])], at: m.index, how: 'NxM' };
  m = n.match(/season[ ._-]*(\d{1,2})[ ._-]*(?:episode|ep)[ ._-]*(\d{1,3})/i) || n.match(/فصل[ ._-]*(\d{1,2}).*?قسمت[ ._-]*(\d{1,3})/);
  if (m) return { s: Number(m[1]), e: [Number(m[2])], at: m.index, how: 'words' };
  const sd = seasonFromDirs(dirs);
  if (sd) {
    m = n.match(/(?:^|[\s._-])(?:e|ep|episode|part|pt|قسمت)[ ._-]*(\d{1,3})(?:[^\d]|$)/i);
    if (m) return { s: sd.s, e: [Number(m[1])], at: m.index, how: 'dir+E', sdir: sd.at };
    m = n.match(/^(\d{1,3})(?:[\s._-]|$)/);
    if (m && ![480, 576, 720].includes(Number(m[1]))) return { s: sd.s, e: [Number(m[1])], at: 0, how: 'dir+num', sdir: sd.at };
  }
  return null;
}
function seriesTitleFor(name, dirs, ep) {
  const n = stripExt(name);
  if (ep.at > 1) { const t = cleanTitle(n.slice(0, ep.at)); if (t.title.length >= 2) return t; }
  // folder: the one above the season folder, or the season folder's own prefix ("Show.S02.1080p")
  const sd = ep.sdir != null ? ep.sdir : (seasonFromDirs(dirs) || {}).at;
  if (sd != null) {
    const own = faDigits(dirs[sd]).split(/[ ._-]*(?:season|S\d{1,2}(?!\d)|فصل)/i)[0];
    const t1 = cleanTitle(own); if (t1.title.length >= 2) return t1;
    if (sd > 0) { const t2 = cleanTitle(dirs[sd - 1]); if (t2.title.length >= 2) return t2; }
  }
  for (let i = dirs.length - 1; i >= 0; i--) { const t = cleanTitle(dirs[i]); if (t.title.length >= 2 && !EXTRAS_DIR.test(dirs[i])) return t; }
  return { title: '', year: null };
}

// ---------- subtitles ----------
function subLang(subName, videoBase) {
  let rest = stripExt(subName);
  if (videoBase && rest.toLowerCase().startsWith(videoBase.toLowerCase())) rest = rest.slice(videoBase.length);
  const toks = faDigits(rest).toLowerCase().split(/[\s._()\[\]-]+/).filter(Boolean);
  let lang = null; const flags = [];
  for (const t of toks.reverse()) {
    if (t === 'forced') flags.push('forced'); else if (t === 'sdh' || t === 'hi' && lang) flags.push('sdh');
    else if (!lang && LANG_OF[t]) lang = LANG_OF[t];
  }
  return { lang, forced: flags.includes('forced'), sdh: flags.includes('sdh') };
}

// ---------- walk ----------
async function walk(root, rel, out, limit, depth = 0) {
  if (out.length >= limit || depth > 10) return;
  let ents; try { ents = await fsp.readdir(S.safeJoin(root, rel), { withFileTypes: true }); } catch { return; }
  for (const de of ents) {
    if (out.length >= limit) return;
    if (de.name.startsWith('.') || SYS_DIR.test(de.name) || /\.part$/i.test(de.name)) continue;
    const r = rel ? `${rel}/${de.name}` : de.name;
    if (de.isDirectory()) await walk(root, r, out, limit, depth + 1);
    else if (de.isFile()) { try { out.push({ rel: r, size: (await fsp.stat(path.join(root, r))).size }); } catch {} }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; } } }));
  return out;
}

// ---------- arr helpers ----------
let profCache = null;
async function profiles() {
  if (profCache && Date.now() - profCache.t < 600000) return profCache;
  const [rq, sq, rm, ss, rr, sr] = await Promise.all([radarr.get('/qualityprofile'), sonarr.get('/qualityprofile'), radarr.get('/movie'), sonarr.get('/series'), radarr.get('/rootfolder'), sonarr.get('/rootfolder')]);
  const common = (arr, profs) => {
    const c = {}; for (const x of arr) c[x.qualityProfileId] = (c[x.qualityProfileId] || 0) + 1;
    const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : (profs.find((p) => /^any$/i.test(p.name)) || profs[0]).id;
  };
  profCache = { t: Date.now(), movieProfile: common(rm, rq), seriesProfile: common(ss, sq), movieRoot: (rr[0] || {}).path || '/data/media/movies', seriesRoot: (sr[0] || {}).path || '/data/media/tv', movies: rm, series: ss };
  return profCache;
}
const movieCand = (x) => ({ title: x.title, year: x.year, tmdbId: x.tmdbId, imdbId: x.imdbId || null, id: x.id || null, hasFile: !!x.hasFile, path: x.path || null });
const seriesCand = (x) => ({ title: x.title, year: x.year, tvdbId: x.tvdbId, id: x.id || null, path: x.path || null, seasons: (x.seasons || []).filter((s) => s.seasonNumber > 0).length });
async function searchMovies(term) { const r = await radarr.get('/movie/lookup?term=' + encodeURIComponent(term), { timeout: 30000 }); return (r || []).slice(0, 8).map(movieCand); }
async function searchSeries(term) { const r = await sonarr.get('/series/lookup?term=' + encodeURIComponent(term), { timeout: 30000 }); return (r || []).slice(0, 8).map(seriesCand); }
function pickBest(cands, title, year) {
  if (!cands.length) return null;
  const nt = norm(title);
  const score = (c) => (norm(c.title) === nt ? 10 : norm(c.title).includes(nt) || nt.includes(norm(c.title)) ? 4 : 0) + (year && c.year ? (c.year === year ? 6 : Math.abs(c.year - year) === 1 ? 3 : -4) : 0) + (c.id ? 2 : 0);
  const ranked = cands.map((c, i) => [score(c) - i * 0.1, c]).sort((a, b) => b[0] - a[0]);
  const best = ranked[0];
  if (best[0] < 4) return null;
  // confidence: exact title + year (or library/parser hit) is 'high'; a close runner-up makes it ambiguous
  const second = ranked[1];
  const conf = best[0] >= 15.5 && !(second && best[0] - second[0] < 3) ? 'high' : 'low';
  return { ...best[1], _conf: conf };
}

// ---------- scan ----------
// returns { drive, root, movies[], series[], other[], skipped[], unknown[], stats }
// Pipeline: scan -> classify -> identify (filename + ffprobe) -> match (Radarr/Sonarr parse + lookup,
// TMDb/TVDb ids) -> dedupe (drive + library) ; the import itself is the job's post phase.
// Low-confidence matches are flagged (needsConfirm) and start unselected so the user confirms them.
async function scan(drive, rel = '', onStep = () => {}) {
  const files = [];
  const stages = []; let st0 = Date.now();
  const stage = (name, n) => { const t = Date.now(); if (stages.length) stages[stages.length - 1].ms = t - st0; st0 = t; stages.push({ name, n: n ?? null }); onStep(name, n); };
  stage('scan');
  await walk(drive.mount, rel, files, 20000);
  const prof = await profiles().catch(() => null);
  const vids = [], subs = [], other = [], skipped = [];
  for (const f of files) {
    const name = path.posix.basename(f.rel);
    const dirs = path.posix.dirname(f.rel) === '.' ? [] : path.posix.dirname(f.rel).split('/');
    f.name = name; f.dirs = dirs;
    if (VIDEO.test(name)) {
      if ((/(^|[\W_])sample([\W_]|$)/i.test(name) || dirs.some((d) => /^samples?$/i.test(d))) && f.size < 600 * 1048576) { skipped.push({ ...f, why: 'sample' }); continue; }
      if (dirs.some((d) => EXTRAS_DIR.test(d)) || EXTRAS_NAME.test(stripExt(name))) { other.push({ ...f, why: 'extra' }); continue; }
      vids.push(f);
    } else if (SUBS.test(name)) subs.push(f);
    else other.push(f);
  }
  stage('classify', vids.length);
  // episodes first (local patterns), the rest are movie candidates
  const eps = [], movs = [];
  for (const v of vids) {
    const ep = parseEpisode(v.name, v.dirs);
    if (ep) { const t = seriesTitleFor(v.name, v.dirs, ep); eps.push({ ...v, s: ep.s, e: ep.e, how: ep.how, stitle: t.title, syear: t.year }); }
    else movs.push(v);
  }
  // identify: technical probe (duration/resolution) to catch mis-classified items
  stage('identify', vids.length);
  await pool(vids.slice(0, 300), 3, async (v) => {
    const m = await META.media(path.join(drive.mount, v.rel)).catch(() => null);
    if (m) v.probe = { dur: m.duration || null, h: (m.video[0] || {}).height || null, vcodec: (m.video[0] || {}).codec || null, audio: m.audio.length, langs: [...new Set(m.audio.map((a) => a.lang).filter(Boolean))] };
  });
  // Radarr parser for movie names (local, fast): file name, then folder name
  await pool(movs, 4, async (m) => {
    const tries = [stripExt(m.name), ...(m.dirs.length ? [m.dirs[m.dirs.length - 1] + ' ' + stripExt(m.name), m.dirs[m.dirs.length - 1]] : [])];
    for (const t of tries) {
      const r = await radarr.get('/parse?title=' + encodeURIComponent(t), { tries: 2 }).catch(() => null);
      const pi = r && r.parsedMovieInfo;
      if (pi && pi.movieTitles && pi.movieTitles[0]) {
        m.mtitle = pi.movieTitles[0]; m.myear = pi.year || null; m.quality = r.parsedMovieInfo.quality && r.parsedMovieInfo.quality.quality && r.parsedMovieInfo.quality.quality.name;
        if (r.movie) m.movie = movieCand(r.movie);
        if (m.myear || r.movie) break;
      }
    }
    if (!m.mtitle) { const c = cleanTitle(m.dirs.length && m.name.length < 12 ? m.dirs[m.dirs.length - 1] : stripExt(m.name)); m.mtitle = c.title; m.myear = c.year; }
  });
  // group
  const mg = new Map();
  for (const m of movs) {
    const k = m.movie ? `id${m.movie.id}` : `${norm(m.mtitle)}|${m.myear || ''}`;
    if (!mg.has(k)) mg.set(k, { kind: 'movie', title: m.mtitle, year: m.myear, files: [], match: m.movie || null });
    mg.get(k).files.push(m);
  }
  const sg = new Map();
  for (const e of eps) {
    const k = norm(e.stitle) || '?';
    if (!sg.has(k)) sg.set(k, { kind: 'series', title: e.stitle, year: e.syear, files: [], match: null });
    sg.get(k).files.push(e);
  }
  stage('match', mg.size + sg.size);
  // match series: library first (by title), then Sonarr lookup
  const libSeries = prof ? prof.series : [];
  await pool([...sg.values()], 3, async (g) => {
    if (!g.title) return;
    const nt = norm(g.title);
    const hit = libSeries.find((x) => norm(x.title) === nt || (x.alternateTitles || []).some((a) => norm(a.title) === nt) || norm(x.cleanTitle) === nt);
    if (hit) { g.match = seriesCand(hit); g.conf = 'high'; return; }
    const pr = await sonarr.get('/parse?title=' + encodeURIComponent(`${g.title} S01E01`), { tries: 1 }).catch(() => null);
    if (pr && pr.series) { g.match = seriesCand(pr.series); g.conf = 'high'; return; }
    const c = await searchSeries(g.year ? `${g.title} ${g.year}` : g.title).catch(() => []);
    g.cands = c; g.match = pickBest(c, g.title, g.year); g.conf = g.match ? g.match._conf : null;
    if (g.match) { const lib = libSeries.find((x) => x.tvdbId === g.match.tvdbId); if (lib) g.match = seriesCand(lib); }
  });
  const libMovies = prof ? prof.movies : [];
  await pool([...mg.values()], 3, async (g) => {
    if (g.match) { g.conf = 'high'; return; }
    if (!g.title) return;
    const c = await searchMovies(g.year ? `${g.title} ${g.year}` : g.title).catch(() => []);
    g.cands = c; g.match = pickBest(c, g.title, g.year); g.conf = g.match ? (g.year ? g.match._conf : 'low') : null;
    if (g.match) { const lib = libMovies.find((x) => x.tmdbId === g.match.tmdbId); if (lib) g.match = movieCand(lib); }
  });
  // attach subtitles to videos
  const allVids = [...movs, ...eps];
  const byDir = new Map();
  for (const v of allVids) { const d = path.posix.dirname(v.rel); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(v); }
  const looseSubs = [];
  for (const s of subs) {
    const d = path.posix.dirname(s.rel), base = stripExt(s.name).toLowerCase();
    let v = (byDir.get(d) || []).find((x) => base.startsWith(stripExt(x.name).toLowerCase()));
    if (!v) {
      const pe = parseEpisode(s.name, s.dirs);
      if (pe) v = [...(byDir.get(d) || []), ...(byDir.get(path.posix.dirname(d)) || [])].find((x) => x.s === pe.s && x.e && x.e[0] === pe.e[0]);
    }
    if (!v && /^(subs?|subtitles?|زیرنویس)$/i.test(path.posix.basename(d))) {
      const parent = path.posix.dirname(d) === '.' ? '.' : path.posix.dirname(d);
      const pv = byDir.get(parent === '.' ? '.' : parent) || [];
      if (pv.length === 1) v = pv[0];
    }
    if (!v && s.dirs.length >= 2 && /^(subs?|subtitles?)$/i.test(s.dirs[s.dirs.length - 2])) { // Subs/<video base>/2_English.srt
      const parent = s.dirs.slice(0, -2).join('/') || '.';
      v = (byDir.get(parent) || []).find((x) => stripExt(x.name).toLowerCase() === s.dirs[s.dirs.length - 1].toLowerCase());
    }
    if (!v && (byDir.get(d) || []).length === 1) v = byDir.get(d)[0];
    if (!v) { looseSubs.push(s); continue; }
    const sl = subLang(s.name, stripExt(v.name));
    if (!sl.lang && s.size < 2 * 1048576) {
      try { const t = await META.decodeText(path.join(drive.mount, s.rel), 65536); sl.lang = META.guessLang(t.text); } catch {}
    }
    (v.subs = v.subs || []).push({ rel: s.rel, size: s.size, name: s.name, ...sl });
  }
  for (const s of looseSubs) other.push({ ...s, why: 'sub' });

  // duplicates within the drive + against the library
  stage('dedupe');
  const movies = [], series = [], unknown = [];
  for (const g of mg.values()) {
    g.files.sort((a, b) => b.size - a.size);
    const [main, ...rest] = g.files;
    for (const r of rest) skipped.push({ ...r, why: 'dupdrive' });
    const it = { kind: 'movie', title: g.title, year: g.year, file: main, match: g.match, cands: g.cands || [], size: main.size + (main.subs || []).reduce((a, s) => a + s.size, 0), conf: g.conf || null };
    // a "movie" shorter than 40 min is suspicious (episode, extra, clip) -> ask
    if (main.probe && main.probe.dur && main.probe.dur < 2400) it.why = 'short';
    it.needsConfirm = !!it.match && (it.conf !== 'high' || !!it.why);
    if (it.match && it.match.id) {
      const lm = libMovies.find((x) => x.id === it.match.id);
      if (lm && lm.hasFile) it.dup = { size: lm.sizeOnDisk || (lm.movieFile && lm.movieFile.size) || 0, quality: lm.movieFile && lm.movieFile.quality && lm.movieFile.quality.quality.name, path: lm.movieFile && lm.movieFile.relativePath };
    }
    (it.match ? movies : unknown).push(it);
  }
  for (const g of sg.values()) {
    const seen = new Map();
    for (const e of g.files.sort((a, b) => b.size - a.size)) { const k = `${e.s}x${e.e.join('-')}`; if (seen.has(k)) skipped.push({ ...e, why: 'dupdrive' }); else seen.set(k, e); }
    const epsList = [...seen.values()].sort((a, b) => a.s - b.s || a.e[0] - b.e[0]);
    const it = { kind: 'series', title: g.title, year: g.year, eps: epsList, match: g.match, cands: g.cands || [], size: epsList.reduce((a, e) => a + e.size + (e.subs || []).reduce((x, s) => x + s.size, 0), 0), conf: g.conf || null };
    it.needsConfirm = !!it.match && it.conf !== 'high';
    await markEpisodeDups(it);
    (it.match ? series : unknown).push(it);
  }
  stages[stages.length - 1].ms = Date.now() - st0;
  const stats = { files: files.length, videos: vids.length, subs: subs.length, other: other.length, skipped: skipped.length };
  return { drive: { id: drive.id, uuid: drive.uuid, name: drive.name, label: drive.label, fstype: drive.fstype, ident: S.identOf(drive) }, root: rel, movies, series, unknown, other, skipped, stats, stages, t: Date.now() };
}
async function markEpisodeDups(it) {
  for (const e of it.eps) delete e.dup;
  it.dups = 0;
  if (!it.match || !it.match.id) return;
  const [list, efs] = await Promise.all([sonarr.get(`/episode?seriesId=${it.match.id}`), sonarr.get(`/episodefile?seriesId=${it.match.id}`)]).catch(() => [[], []]);
  const fmap = new Map((efs || []).map((f) => [f.id, f]));
  for (const e of it.eps) {
    const le = (list || []).find((x) => x.seasonNumber === e.s && x.episodeNumber === e.e[0]);
    if (le && le.hasFile) { const f = fmap.get(le.episodeFileId); e.dup = { size: f ? f.size : 0, quality: f && f.quality && f.quality.quality.name }; it.dups++; }
  }
}
// re-match one item (user correction) -> recomputes duplicates
async function rematch(item, cand) {
  const prof = await profiles();
  item.conf = 'high'; item.needsConfirm = false; delete item.why;
  if (item.kind === 'movie') {
    const lib = prof.movies.find((x) => x.tmdbId === cand.tmdbId);
    item.match = lib ? movieCand(lib) : cand;
    delete item.dup;
    if (lib && lib.hasFile) item.dup = { size: lib.sizeOnDisk || 0, quality: lib.movieFile && lib.movieFile.quality && lib.movieFile.quality.quality.name };
  } else {
    const lib = prof.series.find((x) => x.tvdbId === cand.tvdbId);
    item.match = lib ? seriesCand(lib) : cand;
    await markEpisodeDups(item);
  }
  return item;
}

// ---------- build the job ----------
// sel: { movies: {i: {on, replace}}, series: {i: {on, replace}}, other: bool, unknownAsOther: bool }
function build(res, sel, { uid } = {}) {
  const stage = crypto.randomBytes(4).toString('hex');
  const sroot = path.join(STAGING, stage);
  const files = [], groups = [];
  const add = (src, size, dst, role, grp) => { files.push({ src, size, dst, role, grp }); return files.length - 1; };
  res.movies.forEach((m, i) => {
    const s = sel.movies[i]; if (!s || !s.on) return;
    if (m.dup && !s.replace) return;
    const g = groups.length; const gdir = path.join(sroot, `g${g}`);
    const vidx = add(m.file.rel, m.file.size, path.join(gdir, m.file.name), 'video', g);
    const subs = (m.file.subs || []).map((x, k) => ({ idx: add(x.rel, x.size, path.join(gdir, 'subs', `${k}_${x.name}`), 'sub', g), video: vidx, lang: x.lang, forced: x.forced, ext: path.extname(x.name).toLowerCase() }));
    groups.push({ kind: 'movie', title: m.title, year: m.year, match: m.match, replace: !!m.dup, dir: gdir, videos: [{ idx: vidx, name: m.file.name, size: m.file.size }], subs, state: 'pending' });
  });
  res.series.forEach((sr, i) => {
    const s = sel.series[i]; if (!s || !s.on) return;
    const g = groups.length; const gdir = path.join(sroot, `g${g}`);
    const videos = [], subs = [];
    const used = new Set();
    for (const e of sr.eps) {
      if (e.dup && !s.replace) continue;
      if (s.eps && s.eps[`${e.s}x${e.e[0]}`] === false) continue;
      let nm = e.name; if (used.has(nm.toLowerCase())) nm = `${files.length}_${nm}`; used.add(nm.toLowerCase());
      const vidx = add(e.rel, e.size, path.join(gdir, nm), 'video', g);
      videos.push({ idx: vidx, name: nm, size: e.size, s: e.s, e: e.e });
      (e.subs || []).forEach((x, k) => subs.push({ idx: add(x.rel, x.size, path.join(gdir, 'subs', `${vidx}_${k}_${x.name}`), 'sub', g), video: vidx, lang: x.lang, forced: x.forced, ext: path.extname(x.name).toLowerCase() }));
    }
    if (videos.length) groups.push({ kind: 'series', title: sr.title, year: sr.year, match: sr.match, replace: !!s.replace, dir: gdir, videos, subs, state: 'pending' });
  });
  const others = [];
  if (sel.other) for (const o of res.other) others.push(o);
  if (sel.unknownAsOther) for (const u of res.unknown) { if (u.kind === 'movie') { others.push(u.file); for (const x of u.file.subs || []) others.push(x); } else for (const e of u.eps) { others.push(e); for (const x of e.subs || []) others.push(x); } }
  const rootRel = res.root || '';
  for (const o of others) {
    const r = rootRel && o.rel.startsWith(rootRel + '/') ? o.rel.slice(rootRel.length + 1) : o.rel;
    add(o.rel, o.size, path.join(sroot, 'other', r), 'other', -1);
  }
  const label = S.cleanName(res.drive.label || res.drive.name || 'USB', 'vfat').replace(/\s+/g, '_');
  const date = U.ymd(Date.now());
  const title = `📤 ${res.drive.name}${rootRel ? '/' + rootRel : ''}`;
  return {
    kind: 'import', uid, title,
    src: res.drive.ident ? { type: 'usb', uuid: res.drive.uuid, id: res.drive.id, name: res.drive.name, ident: res.drive.ident } : { type: 'usb', uuid: res.drive.uuid, id: res.drive.id, name: res.drive.name }, dst: { type: 'fs' },
    files: files.map((f) => ({ ...f })),
    data: { stage: sroot, groups, otherRoot: path.join(IMPORT_ROOT, label, date), otherRel: rootRel, drive: res.drive.name },
  };
}

// ---------- post phase (idempotent) ----------
const sleep = U.sleep;
async function waitCommand(api, id, maxMs = 3600000) {
  const t0 = Date.now();
  for (;;) {
    const c = await api.get(`/command/${id}`).catch(() => null);
    if (c && (c.status === 'completed' || c.status === 'failed' || c.status === 'aborted' || c.status === 'cancelled')) return c;
    if (Date.now() - t0 > maxMs) return { status: 'timeout' };
    await sleep(2000);
  }
}
// wait until Radarr/Sonarr has no refresh/rescan running for this item: a ManualImport or our own rescan
// racing the automatic refresh after "add" can make the *arr record the same file twice
async function settle(api, field, id, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const cmds = (await api.get('/command').catch(() => [])) || [];
    const busy = cmds.some((c) => (c.status === 'queued' || c.status === 'started') && /^(Refresh|Rescan)(Movie|Series)$/.test(c.name)
      && c.body && (c.body[field] === id || (c.body[field + 's'] || []).includes(id)));
    if (!busy) return;
    await U.sleep(1500);
  }
}
async function ensureMovie(g) {
  if (g.match.id) { const m = await radarr.get(`/movie/${g.match.id}`).catch(() => null); if (m) return m; }
  const ex = await radarr.get(`/movie?tmdbId=${g.match.tmdbId}`).catch(() => []);
  if (ex && ex.length) return ex[0];
  const prof = await profiles();
  const look = (await radarr.get('/movie/lookup/tmdb?tmdbId=' + g.match.tmdbId).catch(() => null)) || (await searchMovies(`tmdb:${g.match.tmdbId}`).catch(() => [])).find(() => true);
  const body = { ...(look || {}), title: g.match.title, tmdbId: g.match.tmdbId, year: g.match.year, qualityProfileId: prof.movieProfile, rootFolderPath: prof.movieRoot,
    monitored: false, minimumAvailability: 'released', addOptions: { searchForMovie: false, monitor: 'none' } };
  delete body.id;
  const m = await radarr.post('/movie', body);
  profCache = null;
  g.added = true;
  return m;
}
async function ensureSeries(g) {
  let s = null;
  if (g.match.id) s = await sonarr.get(`/series/${g.match.id}`).catch(() => null);
  if (!s) { const all = await sonarr.get('/series'); s = all.find((x) => x.tvdbId === g.match.tvdbId) || null; }
  if (!s) {
    const prof = await profiles();
    const look = (await sonarr.get('/series/lookup?term=' + encodeURIComponent('tvdb:' + g.match.tvdbId))) [0];
    if (!look) throw new Error('series lookup failed');
    const body = { ...look, qualityProfileId: prof.seriesProfile, rootFolderPath: prof.seriesRoot, monitored: false, seasonFolder: true, seriesType: look.seriesType || 'standard',
      seasons: (look.seasons || []).map((x) => ({ ...x, monitored: false })), addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false } };
    delete body.id;
    s = await sonarr.post('/series', body);
    profCache = null;
    g.added = true;
  }
  // episodes must be known before importing
  for (let i = 0; i < 45; i++) { const eps = await sonarr.get(`/episode?seriesId=${s.id}`).catch(() => []); if (eps && eps.length) return { s, eps }; await sleep(2000); }
  return { s, eps: [] };
}
async function moveInto(src, dir, name) {
  await J.mkdirp(dir);
  let dst = path.join(dir, name);
  if (await S.exists(dst)) {
    const a = await fsp.stat(src), b = await fsp.stat(dst);
    if (a.size === b.size) { await fsp.unlink(src); return dst; }
    dst = path.join(dir, await S.freeName(dir, name));
  }
  await fsp.rename(src, dst);
  await J.fsyncDir(dir); await J.fsyncDir(path.dirname(src));
  return dst;
}
async function placeSubs(g, vidx, finalVideo) {
  const done = [];
  for (const s of g.subs.filter((x) => x.video === vidx)) {
    const jf = s._f; if (!jf) continue;
    const base = stripExt(path.basename(finalVideo));
    const tag = [s.lang, s.forced ? 'forced' : null].filter(Boolean).join('.');
    const name = `${base}${tag ? '.' + tag : ''}${s.ext}`;
    const src = jf.dst;
    if (!(await S.exists(src))) { if (await S.exists(path.join(path.dirname(finalVideo), name))) done.push(name); continue; }
    const out = await moveInto(src, path.dirname(finalVideo), name);
    done.push(path.basename(out));
  }
  return done;
}

async function post(job, api) {
  const d = job.data;
  const fl = api.files();
  const byIdx = new Map(fl.map((f) => [f.idx, f]));
  const report = d.report || { movies: [], series: [], other: { n: 0, size: 0, root: d.otherRoot }, failed: [], skipped: [] };
  const okFile = (i) => byIdx.get(i) && byIdx.get(i).status === 'done';
  let touchedJf = false;
  for (const [gi, g] of d.groups.entries()) {
    if (g.state === 'done') continue;
    if (g.state === 'importing') g.recovering = true; // we crashed inside this group last time
    g.state = 'importing'; d.groups[gi] = g; api.saveData(job);
    api.live.cur = `${g.kind === 'movie' ? '🎬' : '📺'} ${g.title}`; api.emit();
    for (const s of g.subs) s._f = okFile(s.idx) ? byIdx.get(s.idx) : null;
    try {
      if (g.kind === 'movie') {
        const v = g.videos[0];
        const vf = byIdx.get(v.idx);
        if (!okFile(v.idx)) { g.state = 'failed'; g.err = 'copy failed'; continue; }
        const m = await ensureMovie(g);
        g.match.id = m.id; d.groups[gi] = g; api.saveData(job);
        await settle(radarr, 'movieId', m.id);
        let finalPath = null;
        // idempotent recovery: wait for an import command we already started, then check what Radarr
        // really has before importing again (a crash between import and 'completed' must not duplicate)
        if (g.importCmd) { await waitCommand(radarr, g.importCmd, 600000).catch(() => null); }
        let staged = await S.exists(vf.dst);
        if (staged && (g.importCmd || g.recovering)) {
          const have = (await radarr.get(`/moviefile?movieId=${m.id}`).catch(() => [])) || [];
          if (have.some((x) => x.size === v.size)) { await fsp.unlink(vf.dst).catch(() => {}); staged = false; g.recovered = 'already-imported'; }
        }
        if (staged) {
          const items = await radarr.get(`/manualimport?folder=${encodeURIComponent(g.dir)}&filterExistingFiles=false`).catch(() => []);
          const it = (items || []).find((x) => x.path === vf.dst);
          let ok = false;
          if (it) {
            const cmd = await radarr.post('/command', { name: 'ManualImport', importMode: 'move', files: [{ path: vf.dst, movieId: m.id, quality: it.quality, languages: it.languages || [], releaseGroup: it.releaseGroup || '', indexerFlags: 0 }] });
            g.importCmd = cmd.id; d.groups[gi] = g; api.saveData(job);
            const r = await waitCommand(radarr, cmd.id);
            await require('./testhooks').hook('after_import_cmd');
            ok = r.status === 'completed' && !(await S.exists(vf.dst));
          }
          if (!ok) { // fallback: place it ourselves and let Radarr rescan
            const mm = await radarr.get(`/movie/${m.id}`);
            finalPath = await moveInto(vf.dst, mm.path, v.name);
            await settle(radarr, 'movieId', m.id);
            const c = await radarr.post('/command', { name: 'RescanMovie', movieId: m.id }); await waitCommand(radarr, c.id, 120000);
            g.fallback = true;
          }
        }
        if (!finalPath) {
          const mfs = await radarr.get(`/moviefile?movieId=${m.id}`).catch(() => []);
          const mm = await radarr.get(`/movie/${m.id}`);
          const f = (mfs || []).find((x) => x.size === v.size) || (mfs || [])[0];
          if (f) finalPath = f.path || path.join(mm.path, f.relativePath);
        }
        if (!finalPath) throw new Error('import not visible in Radarr');
        g.final = finalPath;
        g.subsPlaced = await placeSubs(g, v.idx, finalPath);
        bazarr.http.req(`/movies?radarrid=${m.id}&action=scan-disk`, { method: 'PATCH', tries: 1 }).catch(() => {});
        report.movies = report.movies.filter((x) => x.gi !== gi);
        report.movies.push({ gi, title: g.match.title || g.title, year: g.match.year, path: path.dirname(finalPath), subs: g.subsPlaced.length, added: !!g.added, replaced: !!g.replace, fallback: !!g.fallback });
      } else {
        const { s, eps } = await ensureSeries(g);
        g.match.id = s.id; d.groups[gi] = g; api.saveData(job);
        await settle(sonarr, 'seriesId', s.id);
        if (g.importCmd) { await waitCommand(sonarr, g.importCmd, 600000).catch(() => null); }
        const staged = [];
        let haveEf = null;
        for (const v of g.videos) {
          if (!okFile(v.idx) || !(await S.exists(byIdx.get(v.idx).dst))) continue;
          if (g.importCmd || g.recovering) { // already in Sonarr with the same size? then the staged copy is redundant
            if (!haveEf) haveEf = { efs: (await sonarr.get(`/episodefile?seriesId=${s.id}`).catch(() => [])) || [], eps: eps || [] };
            const le = haveEf.eps.find((x) => x.seasonNumber === v.s && x.episodeNumber === v.e[0]);
            const f = le && le.episodeFileId ? haveEf.efs.find((x) => x.id === le.episodeFileId) : null;
            if (f && f.size === v.size) { await fsp.unlink(byIdx.get(v.idx).dst).catch(() => {}); continue; }
          }
          staged.push(v);
        }
        if (staged.length) {
          const items = await sonarr.get(`/manualimport?folder=${encodeURIComponent(g.dir)}&seriesId=${s.id}&filterExistingFiles=false`).catch(() => []);
          const filesReq = [];
          for (const v of staged) {
            const vf = byIdx.get(v.idx);
            const it = (items || []).find((x) => x.path === vf.dst);
            const ids = v.e.map((n) => (eps.find((x) => x.seasonNumber === v.s && x.episodeNumber === n) || {}).id).filter(Boolean);
            if (!ids.length) continue;
            filesReq.push({ path: vf.dst, seriesId: s.id, episodeIds: ids, quality: it ? it.quality : { quality: { id: 0, name: 'Unknown' }, revision: { version: 1, real: 0 } }, languages: (it && it.languages) || [{ id: 1, name: 'English' }], releaseGroup: (it && it.releaseGroup) || '', indexerFlags: 0 });
          }
          if (filesReq.length) {
            const cmd = await sonarr.post('/command', { name: 'ManualImport', importMode: 'move', files: filesReq });
            g.importCmd = cmd.id; d.groups[gi] = g; api.saveData(job);
            await waitCommand(sonarr, cmd.id);
            await require('./testhooks').hook('after_import_cmd');
          }
          // anything still staged: place it in Season XX ourselves and rescan
          const ser = await sonarr.get(`/series/${s.id}`);
          let fb = 0;
          for (const v of staged) {
            const vf = byIdx.get(v.idx);
            if (await S.exists(vf.dst)) { v.final = await moveInto(vf.dst, path.join(ser.path, `Season ${v.s}`), v.name); fb++; }
          }
          if (fb) { await settle(sonarr, 'seriesId', s.id); const c = await sonarr.post('/command', { name: 'RescanSeries', seriesId: s.id }); await waitCommand(sonarr, c.id, 300000); g.fallback = fb; }
        }
        // final paths from Sonarr
        const efs = await sonarr.get(`/episodefile?seriesId=${s.id}`).catch(() => []);
        const eps2 = await sonarr.get(`/episode?seriesId=${s.id}`).catch(() => []);
        let placed = 0, subsN = 0;
        for (const v of g.videos) {
          if (!okFile(v.idx)) continue;
          const le = eps2.find((x) => x.seasonNumber === v.s && x.episodeNumber === v.e[0]);
          const f = le && le.episodeFileId ? efs.find((x) => x.id === le.episodeFileId) : null;
          const fin = (f && f.path) || v.final;
          if (fin) { v.final = fin; placed++; subsN += (await placeSubs(g, v.idx, fin)).length; }
        }
        bazarr.http.req(`/series?seriesid=${s.id}&action=scan-disk`, { method: 'PATCH', tries: 1 }).catch(() => {});
        const seasons = [...new Set(g.videos.map((v) => v.s))];
        report.series = report.series.filter((x) => x.gi !== gi);
        report.series.push({ gi, title: g.match.title || g.title, eps: placed, seasons, subs: subsN, path: (await sonarr.get(`/series/${s.id}`)).path, added: !!g.added, fallback: g.fallback || 0 });
      }
      g.state = 'done'; touchedJf = true;
    } catch (e) {
      g.state = 'failed'; g.err = U.trunc(U.redact(e.message), 120);
      report.failed = report.failed.filter((x) => x.title !== g.title);
      report.failed.push({ title: g.title, err: g.err });
      U.log('warn', `import group ${g.title}: ${e.message}`);
    }
    for (const s of g.subs) delete s._f;
    d.groups[gi] = g; d.report = report; api.saveData(job);
  }
  // other files
  const others = fl.filter((f) => f.role === 'other' && f.status === 'done');
  if (others.length && !d.otherDone) {
    for (const f of others) {
      const rel = path.relative(path.join(d.stage, 'other'), f.dst);
      if (await S.exists(f.dst)) await moveInto(f.dst, path.dirname(path.join(d.otherRoot, rel)), path.basename(rel));
    }
    report.other = { n: others.length, size: others.reduce((a, f) => a + f.size, 0), root: d.otherRoot };
    d.otherDone = true; d.report = report; api.saveData(job);
  }
  report.skipped = fl.filter((f) => f.status === 'skipped' || f.status === 'failed').map((f) => ({ name: path.basename(f.src), why: f.skip || f.err || f.status }));
  // clean staging (only our own temp dir)
  if (d.stage && d.stage.startsWith(STAGING + '/')) await fsp.rm(d.stage, { recursive: true, force: true }).catch(() => {});
  if (touchedJf) jellyfin.refresh().catch(() => {});
  d.report = report; d.phase = 'done'; api.saveData(job);
}
J.registerPost('import', post);

// stale staging dirs (jobs that no longer exist / finished) older than 3 days
async function cleanStaging() {
  try {
    for (const n of await fsp.readdir(STAGING)) {
      const p = path.join(STAGING, n);
      const st = await fsp.stat(p).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < 3 * 86400000) continue;
      const active = J.list({ active: true, limit: 100 }).some((j) => j.data.stage === p);
      if (!active) await fsp.rm(p, { recursive: true, force: true });
    }
  } catch {}
}

module.exports = { scan, build, rematch, searchMovies, searchSeries, cleanStaging, parseEpisode, seriesTitleFor, cleanTitle, subLang, LANG_FA, IMPORT_ROOT, STAGING };
