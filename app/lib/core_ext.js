'use strict';
// Domain methods added for the seemore API / web panel (merged into core.METHODS).
// Same contract as core.js: [permission, (params, uid) => result]; permission is checked by core.call.
const crypto = require('crypto');
const M = require('./media');
const J = require('./jobs');
const I = require('./importer');
const L = require('./links');
const P = require('./perms');
const OB = require('./outbox');
const LIB = require('./svc/library');
const UO = require('./svc/usbops');
const SEL = require('./svc/selection');
const PV = require('./config/providers');
const AP = require('./config/apply');
const ctl = require('./config/ctl');
const SET = require('./settings');
const DB = require('./db');

const kOf = (p) => (p.k === 's' || p.kind === 'series' ? 's' : 'm');
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
// posters: items seen in search / library results, so the poster proxy never fetches arbitrary URLs
const seen = new Map();
const remember = (items) => { for (const it of items || []) { if (it && it.ref) { seen.set(it.ref, it); if (it.libId) seen.set(`${it.k}${it.libId}L`, it); } } while (seen.size > 3000) seen.delete(seen.keys().next().value); return items; };
const posterItem = (ref) => seen.get(String(ref)) || null;

module.exports = {
  posterItem, remember,
  METHODS: {
    // ---------- library ----------
    'search': ['request', async (p) => { const r = await M.search(String(p.term || '').slice(0, 120), ['movie', 'tv'].includes(p.kind) ? p.kind : 'all'); remember(r.items); return { ...r, errors: r.errors.map((e) => ({ k: e.k, error: e.e.message })) }; }],
    'library.list': ['library', async (p) => remember(await M.libraryList(kOf(p)))],
    'library.movie': ['library', async (p) => { const r = await LIB.movie(Number(p.id)); remember([r]); return r; }],
    'library.series': ['library', async (p) => { const r = await LIB.series(Number(p.id)); remember([r]); return r; }],
    'library.research': ['request', (p) => M.researchItem(kOf(p), Number(p.id), p.season != null ? Number(p.season) : null)],
    'library.releases': ['request', (p) => M.releases(kOf(p), Number(p.id), p.season != null ? Number(p.season) : null)],
    'library.grab': ['request', (p, uid) => { P.audit(uid, 'request', 'grab', String(p.title || p.guid).slice(0, 100)); return M.grab(kOf(p), { guid: String(p.guid), indexerId: Number(p.indexerId) }); }],
    'request.movie': ['request', (p, uid) => { P.audit(uid, 'request', 'movie', String(p.key)); return M.addMovie(Number(p.key), p.quality || SET.get('requests.quality_m')); }],
    'request.series': ['request', (p, uid) => { P.audit(uid, 'request', 'series', String(p.key)); return M.addSeries(Number(p.key), { mode: ['all', 'last', 'fut', 'sel'].includes(p.mode) ? p.mode : 'all', seasons: (p.seasons || []).map(Number), qk: p.quality || SET.get('requests.quality_s') }); }],
    'request.defaults': ['request', () => ({ m: SET.get('requests.quality_m'), s: SET.get('requests.quality_s') })],
    // ---------- external drives ----------
    'usb.copyPlan': ['usb_copy', (p) => UO.copyPlan(String(p.drive), p.sel || {}, p.folder || '')],
    'usb.copy': ['usb_copy', (p, uid) => UO.copyStart(uid, String(p.drive), p.sel || {}, p.folder || '')],
    'usb.transfer': ['usb_manage', (p, uid) => UO.transfer(uid, { from: String(p.from), rel: String(p.rel || ''), to: String(p.to || p.from), destRel: String(p.destRel || ''), op: p.op === 'move' ? 'move' : 'copy', mode: ['ask', 'keep', 'overwrite'].includes(p.mode) ? p.mode : 'ask' })],
    'import.candidates': ['usb_import', (p) => (p.kind === 'series' ? I.searchSeries(String(p.term || '')) : I.searchMovies(String(p.term || '')))],
    // ---------- links from a library selection ----------
    'links.fromSelection': ['links', async (p, uid) => {
      const { title, files } = await SEL.resolve(p.sel || {});
      if (!files.length) throw bad('چیزی انتخاب نشده');
      if (p.kind === 'rar' && !SET.on('features.links_rar')) throw bad('RAR خاموش است');
      const kind = ['zip', 'rar', 'file'].includes(p.kind) ? p.kind : 'zip';
      const list = kind === 'file' ? files.filter((f) => !f.sub).slice(0, 1) : files;
      const l = await L.create({ uid, kind, title: String(p.title || title).slice(0, 120), files: list.map((f) => ({ path: f.src, arc: f.arc })), expires: p.expires ?? null, maxDl: p.maxDl ? Number(p.maxDl) : null });
      P.audit(uid, 'links', 'create', `${l.kind} ${l.items.length} files`);
      return { ...l, state: L.state(l), urls: L.urls(l.token), rar: l.kind === 'rar' ? L.rarProgress(l.token) : undefined };
    }],
    // ---------- jobs ----------
    'jobs.files': ['any', (p, uid) => { const j = J.get(String(p.id)); if (!j || (!P.isOwner(uid) && j.uid !== uid)) throw bad('job not found', 404); return J.files(j.id); }],
    'jobs.events': ['any', (p, uid) => { const j = J.get(String(p.id)); if (!j || (!P.isOwner(uid) && j.uid !== uid)) throw bad('job not found', 404); return J.eventsSince(0, 500, j.id); }],
    // ---------- access control extras ----------
    'acl.invite_delete': ['admin', (p, uid) => { P.deleteInvite(String(p.code), uid); return true; }],
    'acl.panel_list': ['admin', () => require('./api/auth').accounts()],
    'acl.panel_set': ['admin', (p, uid) => require('./api/auth').setAccount({ uid: Number(p.uid), username: String(p.username || ''), password: String(p.password || ''), by: uid })],
    'acl.panel_remove': ['admin', (p, uid) => require('./api/auth').removeAccount(String(p.username || ''), uid)],
    // ---------- settings (classes, history, rollback) ----------
    'settings.catalog': ['admin', () => AP.catalog()],
    'settings.apply': ['admin', (p, uid) => AP.apply(uid, p.changes, { confirm: !!p.confirm })],
    'settings.history': ['admin', (p) => AP.history(Math.min(Number(p.limit) || 100, 500), p.key || null)],
    'settings.rollback': ['admin', (p, uid) => AP.rollback(uid, Number(p.id), { confirm: !!p.confirm })],
    'settings.caddy': ['admin', () => ({ file: require('./config/caddy').FILE, current: require('./config/caddy').current(), rendered: require('./config/caddy').render() })],
    // ---------- indexers (Prowlarr) ----------
    'indexers.list': ['admin', () => PV.indexers()],
    'indexers.get': ['admin', (p) => PV.indexerGet(Number(p.id))],
    'indexers.schema': ['admin', (p) => PV.indexerSchema(String(p.q || ''))],
    'indexers.add': ['admin', async (p, uid) => { const r = await PV.indexerAdd(p); AP.record(uid, `prowlarr.indexer:${r.id}`, 'prowlarr', null, { added: r.name }, { op: 'add' }); return r; }],
    'indexers.update': ['admin', async (p, uid) => { const r = await PV.indexerUpdate(Number(p.id), p.patch || {}); AP.record(uid, `prowlarr.indexer:${r.id}`, 'prowlarr', r.before, r.after, { name: r.name }); return r; }],
    'indexers.test': ['admin', (p) => PV.indexerTest(Number(p.id))],
    'indexers.remove': ['admin', async (p, uid) => { await PV.indexerRemove(Number(p.id)); AP.record(uid, `prowlarr.indexer:${Number(p.id)}`, 'prowlarr', null, { removed: true }, { op: 'remove' }); return true; }],
    // ---------- subtitle providers (Bazarr) + subfa ----------
    'subtitles.providers': ['admin', () => PV.subtitleProviders()],
    'subtitles.setEnabled': ['admin', async (p, uid) => { const r = await PV.setEnabledProviders(p.providers || []); AP.record(uid, 'bazarr.enabled_providers', 'bazarr', r.before, r.after); return r; }],
    'subtitles.configure': ['admin', async (p, uid) => { const r = await PV.configureProvider(String(p.name), p.fields || {}); AP.record(uid, `bazarr.provider:${p.name}`, 'bazarr', r.before, r.after); return r; }],
    // ---------- torrent client ----------
    'torrent.alt': ['admin', async (p) => (p.toggle ? PV.qbitToggleAlt() : PV.qbitAltMode())],
    // ---------- Radarr / Sonarr ----------
    'arr.profiles': ['admin', async () => ({ m: await PV.arrProfiles('m'), s: await PV.arrProfiles('s'), keys: { m: await M.qualityOptions('m').catch(() => []), s: await M.qualityOptions('s').catch(() => []) } })],
    'arr.rootfolders': ['admin', async () => ({ m: await PV.arrRootFolders('m'), s: await PV.arrRootFolders('s') })],
    'arr.addRoot': ['admin', async (p, uid) => { const r = await PV.arrAddRootFolder(kOf(p), p.path); AP.record(uid, `arr.root:${kOf(p)}`, 'arr', null, { path: r.path }); return { id: r.id, path: r.path }; }],
    // ---------- system ----------
    'system.containers': ['admin', () => ctl.containers()],
    'system.logs': ['admin', (p) => ctl.logs(String(p.name), Number(p.tail) || 200)],
    'system.restart': ['admin', (p, uid) => { P.audit(uid, 'admin', 'restart', String(p.name)); return ctl.restart(String(p.name), { by: uid }); }],
    'system.ctl': ['admin', () => ({ proxy: null, helper: ctl.helperInstalled(), requests: ctl.requests(30) })],
    'system.notifications': ['admin', (p) => DB.all('SELECT id,t,uid,kind,status,attempts,sent_at,err FROM notifications ORDER BY id DESC LIMIT ?', Math.min(Number(p.limit) || 50, 300))],
    'system.outbox': ['admin', () => OB.stats()],
  },
};
