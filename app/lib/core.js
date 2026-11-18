'use strict';
// Service layer: every core action as a plain function, permission-checked per user. Used by the
// REST API (lib/api), the internal HTTP RPC and tests. The bot UI (Telegram/Bale) keeps its own
// views but calls the same modules (media, usb, jobs, importer, files, meta, links, perms).
//
//   const core = require('./core');  await core.call(uid, 'library.list', { k: 'm' })
//   POST /rpc  {"uid": <bale user id, optional = owner>, "method": "...", "params": {...}}
//        header X-Api-Key: $INTERNAL_API_KEY   (disabled when the key is not set)
//   GET  /rpc  -> method list with required permission
const path = require('path');
const crypto = require('crypto');
const M = require('./media');
const S = require('./usb');
const J = require('./jobs');
const I = require('./importer');
const F = require('./files');
const META = require('./meta');
const L = require('./links');
const P = require('./perms');
const ctx = require('./ctx');
const { qbit } = require('./clients');

const scans = new Map(); // scanId -> { res, uid, t }
const drive = (id) => { const x = S.readDrives().find((y) => y.id === id || (y.uuid && y.uuid === id)); if (!x) throw Object.assign(new Error('drive not connected'), { status: 404 }); return x; };
const ep = (x) => S.endpoint(x);
const ownJob = (uid, id) => { const j = J.get(id); if (!j) throw Object.assign(new Error('job not found'), { status: 404 }); if (!P.isOwner(uid) && j.uid !== uid) throw Object.assign(new Error('forbidden'), { status: 403 }); return j; };
const underMedia = (p) => { const r = path.resolve(p); if (!(r === S.MEDIA || r.startsWith(S.MEDIA + '/'))) throw Object.assign(new Error('path outside /data/media'), { status: 400 }); return r; };
const pubLink = (l) => (l ? { ...l, state: L.state(l), urls: L.urls(l.token), rar: l.kind === 'rar' ? L.rarProgress(l.token) : undefined } : null);

const METHODS = {
  'me': ['any', (p, uid) => ({ uid, owner: P.isOwner(uid), perms: [...P.permsOf(uid)], user: P.isOwner(uid) ? null : P.getUser(uid) })],
  // library / requests
  'search': ['request', (p) => M.search(String(p.term || ''), p.kind || 'all')],
  'request.movie': ['request', (p) => M.addMovie(p.key, p.quality)],
  'request.series': ['request', (p) => M.addSeries(p.key, { mode: p.mode || 'all', seasons: p.seasons || [], qk: p.quality })],
  'request.qualities': ['request', (p) => M.qualityOptions(p.k === 's' ? 's' : 'm')],
  'library.list': ['library', (p) => M.libraryList(p.k === 's' ? 's' : 'm')],
  'library.item': ['library', (p) => M.libObj(p.k === 's' ? 's' : 'm', Number(p.id))],
  'library.subtitles': ['library', (p) => M.subtitles(p.k === 's' ? 's' : 'm', Number(p.id))],
  'library.files': ['library', () => S.library(true)],
  'library.recent': ['library', () => M.recent()],
  'library.delete': ['lib_delete', (p) => M.deleteItem(p.k === 's' ? 's' : 'm', Number(p.id), !!p.deleteFiles)],
  'calendar': ['calendar', (p) => M.calendar(Number(p.days) || 7)],
  'server.status': ['server', () => M.server()],
  // downloads
  'downloads.list': ['downloads', () => M.downloads()],
  'downloads.pause': ['downloads', (p) => qbit.action('pause', String(p.hash))],
  'downloads.resume': ['downloads', (p) => qbit.action('resume', String(p.hash))],
  'downloads.remove': ['downloads', async (p) => { const it = await M.findDownload(String(p.hash)); if (!it) throw Object.assign(new Error('not found'), { status: 404 }); return M.removeDownload(it, !!p.blocklist); }],
  // usb
  'usb.drives': ['usb_view', () => S.readDrives().map((x) => ({ ...x, busy: J.driveBusy(x.uuid || x.id) }))],
  'usb.list': ['usb_view', (p) => S.listDir(drive(p.drive), String(p.rel || ''))],
  'usb.inspect': ['usb_view', (p) => META.inspect(S.safeJoin(drive(p.drive).mount, String(p.rel || '')))],
  'usb.mkdir': ['usb_manage', (p, uid) => { const x = drive(p.drive); P.audit(uid, 'usb_manage', 'mkdir', `${x.name}/${p.rel || ''}/${p.name}`); return S.mkdirOn(x, String(p.rel || ''), String(p.name)); }],
  'usb.rename': ['usb_manage', (p, uid) => { const x = drive(p.drive); if (J.pathBusy(S.safeJoin(x.mount, String(p.rel || '')))) throw new Error('path busy'); P.audit(uid, 'usb_manage', 'rename', `${x.name}/${p.rel} -> ${p.name}`); return S.renameOn(x, String(p.rel), String(p.name)); }],
  'usb.move': ['usb_manage', (p, uid) => { const x = drive(p.drive); if (J.pathBusy(S.safeJoin(x.mount, String(p.rel || '')))) throw new Error('path busy'); P.audit(uid, 'usb_manage', 'move', `${x.name}/${p.rel} -> ${p.dest}`); return S.moveOn(x, String(p.rel), String(p.dest || ''), p.mode || 'keep'); }],
  'usb.delete': ['usb_manage', (p, uid) => { const x = drive(p.drive); if (!p.rel || J.pathBusy(S.safeJoin(x.mount, String(p.rel || '')))) throw new Error('path busy'); P.audit(uid, 'usb_manage', 'delete', `${x.name}/${p.rel}`); return S.removePath(x, String(p.rel)); }],
  // write protection / health. Changing the mode or repairing is owner/admin only and needs confirm:true
  'usb.mode': ['admin', async (p, uid) => {
    const x = drive(p.drive); const mode = p.mode === 'writable' ? 'writable' : p.mode === 'protected' ? 'protected' : null;
    if (!mode) throw Object.assign(new Error('mode must be protected or writable'), { status: 400 });
    if (p.confirm !== true) throw Object.assign(new Error('confirmation required (confirm: true)'), { status: 428, user: true });
    if (J.driveBusy(x.uuid || x.id)) throw Object.assign(new Error('یک کار انتقال الان از این حافظه استفاده می‌کند'), { status: 409, user: true });
    const r = await S.setMode(x.id, mode); P.audit(uid, 'admin', 'usb_mode', `${x.name} ${mode} ${r.ok ? 'ok' : r.msg}`);
    if (!r.ok) throw Object.assign(new Error(r.msg || 'failed'), { status: /busy/.test(r.msg || '') ? 409 : 502 });
    return { ok: true, mode, drive: S.getDrive(x.id) };
  }],
  'usb.check': ['usb_view', async (p, uid) => {
    const x = drive(p.drive);
    if (!x.ro && J.driveBusy(x.uuid || x.id)) throw Object.assign(new Error('یک کار انتقال الان روی این حافظه می‌نویسد'), { status: 409, user: true });
    const r = await S.checkDrive(x.id); P.audit(uid, 'usb_view', 'usb_check', `${x.name} ${r.msg}`);
    return { ok: !!r.ok, result: r.msg, label: S.fsckLabel(r.msg), log: r.x && r.x.log || null };
  }],
  'usb.repair': ['admin', async (p, uid) => {
    const x = drive(p.drive);
    if (x.protected) throw Object.assign(new Error(S.PROTECTED_MSG), { status: 403, user: true });
    if (p.confirm !== true) throw Object.assign(new Error('confirmation required (confirm: true)'), { status: 428, user: true });
    if (J.driveBusy(x.uuid || x.id)) throw Object.assign(new Error('یک کار انتقال الان از این حافظه استفاده می‌کند'), { status: 409, user: true });
    const r = await S.repairDrive(x.id); P.audit(uid, 'admin', 'usb_repair', `${x.name} ${r.msg}`);
    if (!r.ok) throw Object.assign(new Error(r.msg || 'failed'), { status: /refused/.test(r.msg || '') ? 403 : /busy/.test(r.msg || '') ? 409 : 502 });
    return { ok: true, result: r.msg, label: S.fsckLabel(r.msg), log: r.x && r.x.log || null };
  }],
  'usb.eject': ['usb_view', (p, uid) => { const x = drive(p.drive); if (J.driveBusy(x.uuid || x.id)) throw Object.assign(new Error('a transfer is using this drive'), { status: 409 }); P.audit(uid, 'usb_view', 'eject', x.name); return S.eject(x.id); }],
  // copy library files to a drive: files = absolute paths under /data/media; subtitles next to videos are included
  'usb.copy': ['usb_copy', async (p, uid) => {
    const x = S.assertWritable(drive(p.drive)); const dir = String(p.dest || '').replace(/^\/+/, '');
    const fs = require('fs'); const files = [];
    for (const f of p.files || []) {
      const src = underMedia(f); const st = fs.statSync(src);
      files.push({ src, dst: path.posix.join(dir, path.basename(src)), size: st.size, role: S.SUBS.test(src) ? 'sub' : 'video' });
    }
    if (!files.length) throw new Error('no files');
    const job = J.create({ kind: 'to_usb', uid, title: p.title || `${files.length} files`, src: { type: 'fs' }, dst: ep(x), files });
    P.audit(uid, 'usb_copy', 'copy', `${files.length} files -> ${x.name}`);
    return job;
  }],
  // import from a drive into the archive
  'import.scan': ['usb_import', async (p, uid) => {
    const res = await I.scan(drive(p.drive), String(p.rel || ''));
    const id = crypto.randomBytes(6).toString('hex'); scans.set(id, { res, uid, t: Date.now() });
    for (const [k, v] of scans) if (Date.now() - v.t > 3600000) scans.delete(k);
    P.audit(uid, 'usb_import', 'scan', `${res.drive.name}/${p.rel || ''} ${res.stats.files}`);
    return { scanId: id, ...res };
  }],
  'import.start': ['usb_import', (p, uid) => {
    const sc = scans.get(String(p.scanId)); if (!sc || (sc.uid !== uid && !P.isOwner(uid))) throw Object.assign(new Error('scan expired'), { status: 404 });
    const sel = p.sel || { movies: Object.fromEntries(sc.res.movies.map((_, i) => [i, { on: true }])), series: Object.fromEntries(sc.res.series.map((_, i) => [i, { on: true }])), other: true, unknownAsOther: true };
    const spec = I.build(sc.res, sel, { uid });
    if (!spec.files.length) throw new Error('nothing selected');
    P.audit(uid, 'usb_import', 'import', `${sc.res.drive.name} ${spec.files.length} files`);
    return J.create(spec);
  }],
  'import.get': ['usb_import', (p, uid) => { const sc = scans.get(String(p.scanId)); if (!sc || (sc.uid !== uid && !P.isOwner(uid))) throw Object.assign(new Error('scan expired'), { status: 404 }); return { scanId: p.scanId, ...sc.res }; }],
  // change the match of a scanned movie/series (review step); cand comes from import.candidates
  'import.rematch': ['usb_import', async (p, uid) => {
    const sc = scans.get(String(p.scanId)); if (!sc || (sc.uid !== uid && !P.isOwner(uid))) throw Object.assign(new Error('scan expired'), { status: 404 });
    const list = p.kind === 'series' ? sc.res.series : sc.res.movies;
    const item = list[Number(p.index)]; if (!item || !p.cand) throw Object.assign(new Error('item not found'), { status: 404 });
    const cand = p.kind === 'series' ? { ...p.cand, tvdbId: Number(p.cand.tvdbId) } : { ...p.cand, tmdbId: Number(p.cand.tmdbId) };
    await I.rematch(item, cand); sc.t = Date.now();
    return item;
  }],
  // jobs (own jobs; owner sees all)
  'jobs.list': ['any', (p, uid) => J.list({ active: !!p.active, limit: Number(p.limit) || 30 }).filter((j) => P.isOwner(uid) || j.uid === uid)],
  'jobs.get': ['any', (p, uid) => ({ ...ownJob(uid, p.id), files: p.files ? J.files(p.id) : undefined })],
  'jobs.cancel': ['any', (p, uid) => { ownJob(uid, p.id); return J.cancel(p.id); }],
  'jobs.resume': ['any', (p, uid) => { ownJob(uid, p.id); return J.resume(p.id); }],
  // event log (replayable) and health vs recovery
  'events.since': ['any', (p, uid) => J.eventsSince(Number(p.after) || 0, Math.min(Number(p.limit) || 200, 1000)).filter((e) => P.isOwner(uid) || (J.get(e.job_id) || {}).uid === uid)],
  'system.health': ['server', async () => ({
    container: { uptimeSec: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    recovery: J.recoveryStatus(),
    outbox: require('./outbox').stats(),
    drives: S.readDrives().map((x) => ({ name: x.name, fstype: x.fstype, ro: !!x.ro, fsck: x.fsck || null, marker: !!x.marker })),
  })],
  // server files (read-only)
  'files.roots': ['files', () => F.ROOTS.map((r) => ({ ...r })).concat([{ df: F.df() }])],
  'files.list': ['files', (p) => F.list(String(p.root), String(p.rel || ''))],
  'files.inspect': ['files', (p) => F.inspect(String(p.root), String(p.rel || ''))],
  // download links
  'links.create': ['links', async (p, uid) => {
    const files = (p.files || []).map((f) => (typeof f === 'string' ? { path: underMedia(f) } : { path: underMedia(f.path), arc: f.arc }));
    const l = await L.create({ uid, kind: p.kind || 'zip', title: p.title, files, expires: p.expires ?? null, maxDl: p.maxDl || null });
    P.audit(uid, 'links', 'create', `${l.kind} ${l.items.length} files`);
    return pubLink(l);
  }],
  'links.list': ['links', (p, uid) => L.list({ uid: P.isOwner(uid) && p.all ? null : uid, all: true, limit: Number(p.limit) || 100 }).map(pubLink)],
  'links.get': ['links', (p, uid) => { const l = L.get(p.token); if (!l || (!P.isOwner(uid) && l.creator !== uid)) throw Object.assign(new Error('not found'), { status: 404 }); return { ...pubLink(l), hits: L.hits(l.token, 20) }; }],
  'links.revoke': ['links', (p, uid) => { const l = L.get(p.token); if (!l || (!P.isOwner(uid) && l.creator !== uid)) throw Object.assign(new Error('not found'), { status: 404 }); L.revoke(l.token, uid); P.audit(uid, 'links', 'revoke', l.title); return true; }],
  'links.extend': ['links', (p, uid) => { const l = L.get(p.token); if (!l || (!P.isOwner(uid) && l.creator !== uid)) throw Object.assign(new Error('not found'), { status: 404 }); L.extend(l.token, p.expires ?? null); return true; }],
  // access control (owner)
  'acl.list': ['admin', () => P.list()],
  'acl.get': ['admin', (p) => ({ user: P.getUser(p.uid), audit: P.auditFor(p.uid, 50) })],
  'acl.grant': ['admin', (p, uid) => P.grant({ uid: Number(p.uid), perms: p.perms || [], expires: p.expires ?? null, name: p.name || null, by: uid })],
  'acl.update': ['admin', (p, uid) => P.update(Number(p.uid), p.patch || {}, uid)],
  'acl.revoke': ['admin', (p, uid) => P.revoke(Number(p.uid), uid)],
  'acl.extend': ['admin', (p, uid) => P.extend(Number(p.uid), p.expires ?? null, uid)],
  'acl.remove': ['admin', (p, uid) => P.remove(Number(p.uid), uid)],
  'acl.invite': ['admin', (p, uid) => P.createInvite({ perms: p.perms || [], grantDur: p.grantDur ?? null, grantUntil: p.grantUntil ?? null, ttl: p.ttl || 86400000, by: uid })],
  'acl.invites': ['admin', () => P.invites()],
  'acl.audit': ['admin', (p) => P.auditAll(Number(p.limit) || 100)],
  // runtime settings (tunables + feature flags; live, no restart). Secrets are not settings.
  'settings.list': ['admin', () => require('./settings').all()],
  'settings.set': ['admin', (p, uid) => { const v = require('./settings').set(String(p.key), p.value, uid); P.audit(uid, 'admin', 'setting', `${p.key}=${JSON.stringify(v)}`); return v; }],
  'settings.reset': ['admin', (p, uid) => { P.audit(uid, 'admin', 'setting', `${p.key} reset`); return require('./settings').reset(String(p.key)); }],
  'acl.perms': ['any', () => ({ perms: P.PERMS, presets: P.PRESETS })],
};

// API / panel additions (some override the simpler originals above, e.g. usb.copy now plans with FAT32/space checks)
Object.assign(METHODS, require('./core_ext').METHODS);

async function call(uid, method, params = {}) {
  uid = Number(uid || P.owner());
  const m = METHODS[method];
  if (!m) throw Object.assign(new Error('unknown method'), { status: 404 });
  if (!P.can(uid, m[0])) throw Object.assign(new Error('forbidden'), { status: 403 });
  return ctx.run({ chat: uid, uid }, () => m[1](params || {}, uid));
}
const methods = () => Object.fromEntries(Object.entries(METHODS).map(([k, v]) => [k, v[0]]));

// HTTP handler mounted on the bot's internal port (3000). Returns true when it handled the request.
// SSE: GET /events  (X-Api-Key, optional ?uid=). Replays job_events after Last-Event-ID (or ?after=),
// then streams new ones live. Each event: id=<seq>, event=<type>, data=<json>.
function sseHandler(req, res, KEY) {
  const u = new URL(req.url, 'http://x');
  const uid = Number(u.searchParams.get('uid') || P.owner());
  if (!P.allowed(uid)) { res.writeHead(403); res.end(); return; }
  let after = Number(req.headers['last-event-id'] || u.searchParams.get('after') || 0) || 0;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const visible = (e) => P.isOwner(uid) || (J.get(e.job_id) || {}).uid === uid;
  const write = (e) => { if (!visible(e)) return; res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ job: e.job_id, t: e.t, state: e.state, data: e.data })}\n\n`); after = Math.max(after, e.seq); };
  for (const e of J.eventsSince(after, 1000)) write(e);
  const on = (e) => { if (e.seq > after) write(e); };
  J.ev.on('event', on);
  const ka = setInterval(() => res.write(': ka\n\n'), 20000);
  req.on('close', () => { clearInterval(ka); J.ev.off('event', on); });
}

function rpcHandler(req, res) {
  const url = req.url.split('?')[0];
  if (url !== '/rpc' && url !== '/events') return false;
  const KEY = process.env.INTERNAL_API_KEY || '';
  const given = String(req.headers['x-api-key'] || '');
  const ok = KEY && given.length === KEY.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(KEY));
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (!ok) { send(404, { ok: false }); return true; }
  if (url === '/events') { sseHandler(req, res, KEY); return true; }
  if (req.method === 'GET') { send(200, { ok: true, methods: methods() }); return true; }
  if (req.method !== 'POST') { send(405, { ok: false }); return true; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let j; try { j = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
    try { send(200, { ok: true, result: (await call(j.uid, String(j.method || ''), j.params)) ?? null }); }
    catch (e) { send(e.status || 500, { ok: false, error: String(e.message || e).slice(0, 300) }); }
  });
  return true;
}

module.exports = { call, methods, rpcHandler, METHODS };
