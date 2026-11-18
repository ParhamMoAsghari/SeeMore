'use strict';
// REST routes (/api/v1) -> core domain methods. Each route maps HTTP shape to one core method; the core
// checks permissions (perms.js) for the session's user. No route exposes a Radarr/Sonarr/qBittorrent call
// directly — everything is a seemore operation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../core');
const P = require('../perms');
const SET = require('../settings');
const M = require('../media');
const X = require('../core_ext');
const auth = require('./auth');

const HANDLED = Symbol('handled');
const R = [];
const call = (method, map = () => ({})) => (ctx, uid) => core.call(uid, method, map(ctx));
function route(method, pattern, fn, status) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  R.push({ method, re, keys, fn, status });
}
function match(method, pathname) {
  const p = pathname.replace(/^\/api\/v1/, '');
  for (const r of R) { if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue; const m = r.re.exec(p); if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; }
  return null;
}
const kind = (v) => (v === 'series' || v === 's' || v === 'tv' ? 's' : 'm');
const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) throw Object.assign(new Error('invalid number'), { status: 400 }); return n; };
const expires = (v) => (v === null || v === undefined || v === '' ? null : num(v));

async function me(uid, username) {
  const perms = [...P.permsOf(uid)];
  const flags = {}; for (const k of Object.keys(SET.DEFS)) if (k.startsWith('features.')) flags[k.slice(9)] = SET.get(k);
  const u = P.isOwner(uid) ? null : P.getUser(uid);
  return { uid, username, owner: P.isOwner(uid), perms, features: flags, name: u ? u.name : null, expires: u ? u.expires : null, version: require('../../package.json').version, botUser: process.env.SEEMORE_BOT_USER || null, messenger: SET.get('bot.messenger'), startLinkBase: SET.get('bot.messenger') === 'bale' ? 'https://ble.ir/' : 'https://t.me/' };
}

// ---------- media / requests ----------
route('GET', '/media/search', call('search', (c) => ({ term: c.query.term, kind: c.query.kind })));
route('GET', '/media/qualities', call('request.qualities', (c) => ({ k: kind(c.query.kind) })));
route('GET', '/media/request-defaults', call('request.defaults'));
route('POST', '/media/requests', (c, uid) => {
  const b = c.body; if (!b.key) throw Object.assign(new Error('key required'), { status: 400 });
  return kind(b.kind) === 'm' ? core.call(uid, 'request.movie', { key: b.key, quality: b.quality }) : core.call(uid, 'request.series', { key: b.key, quality: b.quality, mode: b.mode, seasons: b.seasons });
}, 201);
const POSTER_DIR = path.join(path.dirname(process.env.DB_FILE || '/state/bot.db'), 'cache', 'posters');
route('GET', '/media/posters/:ref', async (c, uid) => {
  if (!P.can(uid, 'library') && !P.can(uid, 'request')) throw Object.assign(new Error('forbidden'), { status: 403 });
  const it = X.posterItem(c.params.ref); if (!it) throw Object.assign(new Error('unknown poster'), { status: 404 });
  const f = path.join(POSTER_DIR, crypto.createHash('sha1').update(`${it.poster}|${it.local}|${it.libId}`).digest('hex') + '.jpg');
  let buf = null; try { buf = fs.readFileSync(f); } catch {}
  if (!buf) {
    buf = await M.posterBuffer(it).catch(() => null);
    if (!buf) throw Object.assign(new Error('poster unavailable'), { status: 404 });
    try { fs.mkdirSync(POSTER_DIR, { recursive: true }); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); const all = fs.readdirSync(POSTER_DIR); if (all.length > 600) for (const n of all.slice(0, 100)) fs.unlinkSync(path.join(POSTER_DIR, n)); } catch {}
  }
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' }); c.res.end(buf);
  return HANDLED;
});

// ---------- library ----------
route('GET', '/library', call('library.list', (c) => ({ k: kind(c.query.kind) })));
route('GET', '/library/recent', call('library.recent'));
route('GET', '/library/files', call('library.files'));
route('GET', '/library/movies/:id', call('library.movie', (c) => ({ id: num(c.params.id) })));
route('GET', '/library/series/:id', call('library.series', (c) => ({ id: num(c.params.id) })));
route('DELETE', '/library/:kind/:id', call('library.delete', (c) => ({ k: kind(c.params.kind), id: num(c.params.id), deleteFiles: c.query.deleteFiles === '1' || c.query.deleteFiles === 'true' })));
route('POST', '/library/:kind/:id/search', call('library.research', (c) => ({ k: kind(c.params.kind), id: num(c.params.id), season: c.body.season })));
route('GET', '/library/:kind/:id/releases', call('library.releases', (c) => ({ k: kind(c.params.kind), id: num(c.params.id), season: c.query.season })));
route('POST', '/library/:kind/:id/grab', call('library.grab', (c) => ({ k: kind(c.params.kind), id: num(c.params.id), guid: c.body.guid, indexerId: c.body.indexerId, title: c.body.title })));
route('GET', '/calendar', call('calendar', (c) => ({ days: Math.min(Number(c.query.days) || 14, 60) })));

// ---------- downloads ----------
route('GET', '/downloads', call('downloads.list'));
route('POST', '/downloads/:hash/pause', call('downloads.pause', (c) => ({ hash: c.params.hash })));
route('POST', '/downloads/:hash/resume', call('downloads.resume', (c) => ({ hash: c.params.hash })));
route('DELETE', '/downloads/:hash', call('downloads.remove', (c) => ({ hash: String(c.params.hash).slice(0, 12), blocklist: c.query.blocklist === '1' })));

// ---------- storage: devices ----------
route('GET', '/storage/devices', call('usb.drives'));
route('GET', '/storage/devices/:id/entries', call('usb.list', (c) => ({ drive: c.params.id, rel: c.query.path || '' })));
route('GET', '/storage/devices/:id/metadata', call('usb.inspect', (c) => ({ drive: c.params.id, rel: c.query.path || '' })));
route('POST', '/storage/devices/:id/mkdir', call('usb.mkdir', (c) => ({ drive: c.params.id, rel: c.body.path || '', name: c.body.name })));
route('POST', '/storage/devices/:id/rename', call('usb.rename', (c) => ({ drive: c.params.id, rel: c.body.path, name: c.body.name })));
route('POST', '/storage/devices/:id/move', call('usb.transfer', (c) => ({ from: c.params.id, to: c.body.to || c.params.id, rel: c.body.path, destRel: c.body.dest || '', op: c.body.op === 'copy' ? 'copy' : 'move', mode: c.body.mode || 'ask' })));
route('DELETE', '/storage/devices/:id/entries', call('usb.delete', (c) => ({ drive: c.params.id, rel: c.query.path })));
route('POST', '/storage/devices/:id/eject', call('usb.eject', (c) => ({ drive: c.params.id })));
// exports (copy library -> drive)
route('POST', '/storage/exports/plan', call('usb.copyPlan', (c) => ({ drive: c.body.drive, sel: c.body.sel, folder: c.body.folder })));
route('POST', '/storage/exports', call('usb.copy', (c) => ({ drive: c.body.drive, sel: c.body.sel, folder: c.body.folder })), 201);
// imports (drive -> archive): scan -> review (rematch) -> confirm
route('POST', '/storage/imports/scans', call('import.scan', (c) => ({ drive: c.body.drive, rel: c.body.path || '' })), 201);
route('GET', '/storage/imports/scans/:id', call('import.get', (c) => ({ scanId: c.params.id })));
route('POST', '/storage/imports/scans/:id/rematch', call('import.rematch', (c) => ({ scanId: c.params.id, kind: c.body.kind, index: c.body.index, cand: c.body.cand })));
route('GET', '/storage/imports/candidates', call('import.candidates', (c) => ({ kind: c.query.kind, term: c.query.term })));
route('POST', '/storage/imports', call('import.start', (c) => ({ scanId: c.body.scanId, sel: c.body.sel })), 201);

// ---------- server files ----------
route('GET', '/files/roots', call('files.roots'));
route('GET', '/files/:root/entries', call('files.list', (c) => ({ root: c.params.root, rel: c.query.path || '' })));
route('GET', '/files/:root/metadata', call('files.inspect', (c) => ({ root: c.params.root, rel: c.query.path || '' })));

// ---------- shares (download links) ----------
route('GET', '/shares', call('links.list', (c) => ({ all: c.query.all === '1', limit: c.query.limit })));
route('POST', '/shares', (c, uid) => {
  const b = c.body;
  if (b.sel) return core.call(uid, 'links.fromSelection', { sel: b.sel, kind: b.kind, title: b.title, expires: expires(b.expires), maxDl: b.maxDl });
  return core.call(uid, 'links.create', { files: b.files, kind: b.kind, title: b.title, expires: expires(b.expires), maxDl: b.maxDl });
}, 201);
route('GET', '/shares/:token', call('links.get', (c) => ({ token: c.params.token })));
route('PATCH', '/shares/:token', call('links.extend', (c) => ({ token: c.params.token, expires: expires(c.body.expires) })));
route('DELETE', '/shares/:token', call('links.revoke', (c) => ({ token: c.params.token })));

// ---------- jobs ----------
route('GET', '/jobs', call('jobs.list', (c) => ({ active: c.query.active === '1', limit: Math.min(Number(c.query.limit) || 30, 200) })));
route('GET', '/jobs/:id', call('jobs.get', (c) => ({ id: c.params.id, files: c.query.files === '1' })));
route('GET', '/jobs/:id/events', call('jobs.events', (c) => ({ id: c.params.id })));
route('POST', '/jobs/:id/cancel', call('jobs.cancel', (c) => ({ id: c.params.id })));
route('POST', '/jobs/:id/resume', call('jobs.resume', (c) => ({ id: c.params.id })));

// ---------- users / grants / invites / audit ----------
route('GET', '/permissions', call('acl.perms'));
route('GET', '/users', call('acl.list'));
route('POST', '/users', call('acl.grant', (c) => ({ uid: c.body.uid, perms: c.body.perms, expires: expires(c.body.expires), name: c.body.name })), 201);
route('GET', '/users/:uid', call('acl.get', (c) => ({ uid: num(c.params.uid) })));
route('PATCH', '/users/:uid', call('acl.update', (c) => ({ uid: num(c.params.uid), patch: { ...(c.body.perms ? { perms: c.body.perms } : {}), ...('expires' in c.body ? { expires: expires(c.body.expires) } : {}), ...(c.body.note != null ? { note: String(c.body.note).slice(0, 200) } : {}) } })));
route('POST', '/users/:uid/revoke', call('acl.revoke', (c) => ({ uid: num(c.params.uid) })));
route('POST', '/users/:uid/extend', call('acl.extend', (c) => ({ uid: num(c.params.uid), expires: expires(c.body.expires) })));
route('DELETE', '/users/:uid', async (c, uid) => { const r = await core.call(uid, 'acl.remove', { uid: num(c.params.uid) }); auth.revokeSessions(num(c.params.uid)); return r; });
route('GET', '/invites', call('acl.invites'));
route('POST', '/invites', call('acl.invite', (c) => ({ perms: c.body.perms, grantDur: c.body.grantDur ?? null, grantUntil: c.body.grantUntil ?? null, ttl: Math.min(Number(c.body.ttl) || 86400000, 30 * 86400000) })), 201);
route('DELETE', '/invites/:code', call('acl.invite_delete', (c) => ({ code: c.params.code })));
route('GET', '/audit', call('acl.audit', (c) => ({ limit: Math.min(Number(c.query.limit) || 100, 1000) })));
route('GET', '/panel-accounts', call('acl.panel_list'));
route('PUT', '/panel-accounts/:username', call('acl.panel_set', (c) => ({ username: c.params.username, uid: c.body.uid, password: c.body.password })));
route('DELETE', '/panel-accounts/:username', call('acl.panel_remove', (c) => ({ username: c.params.username })));
route('POST', '/auth/password', (c) => auth.changeOwnPassword(c.sess, c.body.current, c.body.next));
route('POST', '/auth/password/shared', (c, uid) => { if (!P.isOwner(uid)) throw Object.assign(new Error('forbidden'), { status: 403 }); return auth.resetOwnerToShared(uid); });
route('GET', '/auth/sessions', (c, uid) => auth.sessionsOf(uid));
route('DELETE', '/auth/sessions', (c, uid) => { auth.revokeSessions(uid, c.sess.id.slice(0, 10)); return { ok: true }; });

// ---------- settings ----------
route('GET', '/settings', call('settings.catalog'));
route('PUT', '/settings', call('settings.apply', (c) => ({ changes: c.body.changes, confirm: !!c.body.confirm })));
route('GET', '/settings/history', call('settings.history', (c) => ({ limit: c.query.limit, key: c.query.key })));
route('POST', '/settings/history/:id/rollback', call('settings.rollback', (c) => ({ id: num(c.params.id), confirm: !!c.body.confirm })));
route('GET', '/settings/caddy', call('settings.caddy'));
route('GET', '/indexers', call('indexers.list'));
route('GET', '/indexers/schema', call('indexers.schema', (c) => ({ q: c.query.q })));
route('POST', '/indexers', call('indexers.add', (c) => c.body), 201);
route('GET', '/indexers/:id', call('indexers.get', (c) => ({ id: num(c.params.id) })));
route('PATCH', '/indexers/:id', call('indexers.update', (c) => ({ id: num(c.params.id), patch: c.body })));
route('POST', '/indexers/:id/test', call('indexers.test', (c) => ({ id: num(c.params.id) })));
route('DELETE', '/indexers/:id', call('indexers.remove', (c) => ({ id: num(c.params.id) })));
route('GET', '/subtitles/providers', call('subtitles.providers'));
route('PUT', '/subtitles/providers/enabled', call('subtitles.setEnabled', (c) => ({ providers: c.body.providers })));
route('PATCH', '/subtitles/providers/:name', call('subtitles.configure', (c) => ({ name: c.params.name, fields: c.body.fields })));
route('GET', '/torrent/alt-speed', call('torrent.alt'));
route('POST', '/torrent/alt-speed/toggle', call('torrent.alt', () => ({ toggle: true })));
route('GET', '/arr/profiles', call('arr.profiles'));
route('GET', '/arr/rootfolders', call('arr.rootfolders'));
route('POST', '/arr/rootfolders', call('arr.addRoot', (c) => ({ k: kind(c.body.kind), path: c.body.path })), 201);

// ---------- system / health ----------
route('GET', '/health', async (c, uid) => {
  const out = { ok: true, t: Date.now() };
  if (P.can(uid, 'server')) {
    const h = await core.call(uid, 'system.health');
    const srv = await M.server().catch(() => null);
    out.services = srv ? srv.services.map(([name, r]) => ({ name, ok: r.ok, ms: r.ms, error: r.err })) : null;
    out.process = h.container; out.drives = h.drives;
    out.recovery = h.recovery; out.outbox = h.outbox;   // job recovery state is reported separately from service health
    if (P.isOwner(uid)) { try { out.containers = await require('../config/ctl').containers(); } catch (e) { out.containers = { error: e.message }; } }
  }
  return out;
});
route('GET', '/system/status', call('server.status'));
route('GET', '/system/containers', call('system.containers'));
route('GET', '/system/containers/:name/logs', call('system.logs', (c) => ({ name: c.params.name, tail: c.query.tail })));
route('POST', '/system/containers/:name/restart', call('system.restart', (c) => ({ name: c.params.name })));
route('GET', '/system/notifications', call('system.notifications', (c) => ({ limit: c.query.limit })));
route('GET', '/system/ctl', call('system.ctl'));

module.exports = { match, me, HANDLED, routes: R };
