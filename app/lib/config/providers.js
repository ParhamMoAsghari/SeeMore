'use strict';
// External service configuration exposed as seemore domain operations (the panel never talks to
// Prowlarr/Bazarr/qBittorrent/Radarr/Sonarr directly). Secrets (passwords / API keys inside provider
// settings) are masked on read ('***') and left unchanged when '***' comes back on write.
const fs = require('fs');
const path = require('path');
const { prowlarr, bazarr, qbit, radarr, sonarr } = require('../clients');
const ctl = require('./ctl');

const MASK = '***';
const SECRET_FIELD = /pass|key|token|secret|cookie|captcha|hash/i;
const bad = (m, status = 400) => Object.assign(new Error(m), { status, user: true });

// ---------------- Prowlarr indexers ----------------
const fieldsOut = (fields) => (fields || []).filter((f) => !f.hidden || f.hidden === 'visible').map((f) => ({
  name: f.name, label: f.label || f.name, type: f.type, advanced: !!f.advanced, helpText: f.helpText || '',
  value: f.privacy && f.privacy !== 'normal' ? (f.value ? MASK : '') : f.value, secret: !!(f.privacy && f.privacy !== 'normal'),
  options: f.selectOptions ? f.selectOptions.map((o) => ({ value: o.value, name: o.name })) : undefined,
}));
async function indexers() {
  const [list, st] = await Promise.all([prowlarr.get('/indexer'), prowlarr.get('/indexerstatus').catch(() => [])]);
  const sm = new Map(st.map((s) => [s.indexerId, s]));
  return list.map((i) => ({
    id: i.id, name: i.name, enable: i.enable, protocol: i.protocol, privacy: i.privacy, priority: i.priority,
    implementation: i.implementation, definitionName: i.definitionName, appProfileId: i.appProfileId, tags: i.tags || [],
    baseUrl: ((i.fields || []).find((f) => f.name === 'baseUrl') || {}).value || null,
    status: sm.has(i.id) ? { disabledTill: sm.get(i.id).disabledTill || null, failure: sm.get(i.id).mostRecentFailure || null } : null,
  })).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}
let schemaCache = { t: 0, list: [] };
async function indexerSchema(q = '') {
  if (Date.now() - schemaCache.t > 3600000) schemaCache = { t: Date.now(), list: await prowlarr.get('/indexer/schema', { timeout: 60000 }) };
  const s = String(q || '').toLowerCase().trim();
  return schemaCache.list.filter((x) => !s || x.name.toLowerCase().includes(s) || (x.description || '').toLowerCase().includes(s)).slice(0, 40)
    .map((x) => ({ definitionName: x.definitionName, name: x.name, privacy: x.privacy, protocol: x.protocol, description: x.description || '', language: x.language || '', fields: fieldsOut(x.fields) }));
}
async function indexerAdd({ definitionName, fields = {}, priority = 25, enable = true }) {
  if (!definitionName) throw bad('definitionName required');
  if (Date.now() - schemaCache.t > 3600000) await indexerSchema('');
  const sc = schemaCache.list.find((x) => x.definitionName === definitionName);
  if (!sc) throw bad('unknown indexer definition');
  const profiles = await prowlarr.get('/appprofile').catch(() => []);
  const body = JSON.parse(JSON.stringify(sc));
  for (const f of body.fields) if (Object.prototype.hasOwnProperty.call(fields, f.name) && fields[f.name] !== MASK) f.value = fields[f.name];
  Object.assign(body, { enable: !!enable, priority: Math.max(1, Math.min(50, Number(priority) || 25)), appProfileId: (profiles[0] && profiles[0].id) || 1, name: fields.name || sc.name, tags: [] });
  const r = await prowlarr.post('/indexer', body, { timeout: 90000 });
  return { id: r.id, name: r.name };
}
async function indexerUpdate(id, patch = {}) {
  const cur = await prowlarr.get(`/indexer/${Number(id)}`);
  const before = { enable: cur.enable, priority: cur.priority };
  if ('enable' in patch) cur.enable = !!patch.enable;
  if ('priority' in patch) { const p = Number(patch.priority); if (!(p >= 1 && p <= 50)) throw bad('priority must be 1..50'); cur.priority = p; }
  if (patch.fields) for (const f of cur.fields) if (Object.prototype.hasOwnProperty.call(patch.fields, f.name) && patch.fields[f.name] !== MASK) f.value = patch.fields[f.name];
  await prowlarr.put(`/indexer/${cur.id}`, cur, { timeout: 90000 });
  return { id: cur.id, name: cur.name, before, after: { enable: cur.enable, priority: cur.priority } };
}
async function indexerTest(id) {
  const cur = await prowlarr.get(`/indexer/${Number(id)}`);
  try { await prowlarr.post('/indexer/test', cur, { timeout: 90000 }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
async function indexerGet(id) { const i = await prowlarr.get(`/indexer/${Number(id)}`); return { id: i.id, name: i.name, enable: i.enable, priority: i.priority, definitionName: i.definitionName, fields: fieldsOut(i.fields) }; }
async function indexerRemove(id) { await prowlarr.del(`/indexer/${Number(id)}`); return true; }

// ---------------- Bazarr subtitle providers ----------------
// providers that work without configuration are listed even when Bazarr has no settings section for them
const NO_CONFIG = ['yifysubtitles', 'subtitlecat', 'podnapisi', 'gestdown', 'supersubtitles', 'tvsubtitles', 'wizdom', 'subscenter', 'bsplayer', 'animekalesi', 'nekur', 'regielive', 'soustitreseu', 'subssabbz', 'subsunacs', 'subtis', 'zimuku', 'hosszupuska', 'greeksubs', 'greeksubtitles', 'subtitrarinoi', 'yavkanet', 'legendasdivx'];
const NOT_PROVIDER = new Set(['general', 'auth', 'proxy', 'sonarr', 'radarr', 'plex', 'backup', 'analytics', 'cors', 'postgresql', 'log', 'translator', 'jellyfin', 'movie_scores', 'series_scores', 'subsync', 'ui', 'notifications', 'anticaptcha', 'deathbycaptcha', 'captchaai', 'whisperai', 'embeddedsubtitles_', 'betaseries_']);
async function bazarrSettings() { return bazarr.get('/system/settings'); }
const maskObj = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, SECRET_FIELD.test(k) && v ? MASK : v]));
async function subtitleProviders() {
  const [st, pv] = await Promise.all([bazarrSettings(), bazarr.get('/providers').catch(() => ({ data: [] }))]);
  const enabled = st.general.enabled_providers || [];
  const status = new Map(((pv && pv.data) || []).map((p) => [p.name, p]));
  const names = new Set([...Object.keys(st).filter((k) => !NOT_PROVIDER.has(k) && st[k] && typeof st[k] === 'object' && !Array.isArray(st[k])), ...NO_CONFIG, ...enabled]);
  return [...names].sort().map((n) => ({ name: n, enabled: enabled.includes(n), status: status.get(n) ? status.get(n).status : null, retry: status.get(n) ? status.get(n).retry : null, settings: st[n] && typeof st[n] === 'object' ? maskObj(st[n]) : null }));
}
async function bazarrPost(pairs) {
  const body = new URLSearchParams();
  for (const [k, v] of pairs) body.append(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  await bazarr.http.req('/system/settings', { method: 'POST', body, tries: 1, timeout: 30000 });
}
async function setEnabledProviders(list) {
  list = [...new Set((list || []).map(String).filter((x) => /^[a-z0-9_]+$/.test(x)))];
  if (!list.length) throw bad('at least one subtitle provider must stay enabled');
  const before = (await bazarrSettings()).general.enabled_providers || [];
  await bazarrPost(list.map((p) => ['settings-general-enabled_providers', p]));
  const after = (await bazarrSettings()).general.enabled_providers || [];
  return { before, after };
}
async function configureProvider(name, fields = {}) {
  if (!/^[a-z0-9_]+$/.test(name) || NOT_PROVIDER.has(name)) throw bad('invalid provider');
  const st = await bazarrSettings();
  const cur = st[name]; if (!cur || typeof cur !== 'object') throw bad('this provider has no settings');
  const pairs = []; const before = {}; const after = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in cur)) throw bad(`unknown field ${k}`);
    if (v === MASK) continue;
    pairs.push([`settings-${name}-${k}`, v]);
    if (!SECRET_FIELD.test(k)) { before[k] = cur[k]; after[k] = v; }
  }
  if (pairs.length) await bazarrPost(pairs);
  return { before, after };
}

// ---------------- qBittorrent ----------------
const QB_KEYS = {
  dl_limit: ['int', 0, 1e10, 'Global download limit (bytes/s, 0 = unlimited)'], up_limit: ['int', 0, 1e10, 'Global upload limit (bytes/s, 0 = unlimited)'],
  alt_dl_limit: ['int', 0, 1e10, 'Alternative download limit (bytes/s)'], alt_up_limit: ['int', 0, 1e10, 'Alternative upload limit (bytes/s)'],
  queueing_enabled: ['bool', 0, 1, 'Torrent queueing'], max_active_downloads: ['int', -1, 1000, 'Max active downloads'], max_active_uploads: ['int', -1, 1000, 'Max active uploads'],
  max_active_torrents: ['int', -1, 2000, 'Max active torrents'], max_connec: ['int', -1, 100000, 'Global max connections'], max_connec_per_torrent: ['int', -1, 10000, 'Max connections per torrent'],
  max_uploads: ['int', -1, 10000, 'Global max upload slots'], max_ratio_enabled: ['bool', 0, 1, 'Stop seeding at ratio'], max_ratio: ['num', -1, 1000, 'Seeding ratio limit'],
  max_seeding_time_enabled: ['bool', 0, 1, 'Stop seeding after time'], max_seeding_time: ['int', -1, 525600, 'Seeding time limit (minutes)'],
  scheduler_enabled: ['bool', 0, 1, 'Use alternative limits on a schedule'], dht: ['bool', 0, 1, 'DHT'], pex: ['bool', 0, 1, 'Peer exchange'],
};
async function qbitPrefs() { const p = await qbit.req('/app/preferences'); return Object.fromEntries(Object.keys(QB_KEYS).map((k) => [k, p[k]])); }
function qbitCoerce(k, v) {
  const d = QB_KEYS[k]; if (!d) throw bad('unknown qBittorrent setting ' + k);
  if (d[0] === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
  const n = Number(v); if (!Number.isFinite(n) || n < d[1] || n > d[2]) throw bad(`${k} must be between ${d[1]} and ${d[2]}`);
  return d[0] === 'int' ? Math.round(n) : n;
}
async function qbitSet(obj) { await qbit.req('/app/setPreferences', { method: 'POST', body: new URLSearchParams({ json: JSON.stringify(obj) }), tries: 1 }); return qbitPrefs(); }
async function qbitAltMode() { return Number(await qbit.req('/transfer/speedLimitsMode')) === 1; }
async function qbitToggleAlt() { await qbit.req('/transfer/toggleSpeedLimitsMode', { method: 'POST', tries: 1 }); return qbitAltMode(); }

// ---------------- Radarr / Sonarr ----------------
const arr = (k) => (k === 's' ? sonarr : radarr);
async function arrProfiles(k) { return (await arr(k).get('/qualityprofile')).map((p) => ({ id: p.id, name: p.name, cutoff: p.cutoff, upgradeAllowed: p.upgradeAllowed })); }
async function arrRootFolders(k) { return (await arr(k).get('/rootfolder')).map((r) => ({ id: r.id, path: r.path, accessible: r.accessible, freeSpace: r.freeSpace })); }
async function arrAddRootFolder(k, p) {
  const r = path.posix.normalize(String(p || '')).replace(/\/$/, '');
  if (!/^\/data\/media\/[^/]+(\/[^/]+)*$/.test(r) || r.includes('..')) throw bad('root folders must be inside /data/media');
  return arr(k).post('/rootfolder', { path: r });
}

// ---------------- subfa (overrides file read at start-up -> "reload" class) ----------------
const SUBFA_FILE = process.env.SUBFA_OVERRIDES || '/ext/subfa/overrides.json';
const SUBFA_KEYS = {
  ENABLED: ['bool', 0, 1, 'subf2m fallback enabled (0 = subfa idles)'],
  POLL_SECONDS: ['int', 60, 3600, 'Quick check interval (s)'], SWEEP_SECONDS: ['int', 600, 86400, 'Full reconcile interval (s)'],
  BAZARR_GRACE: ['int', 0, 86400, 'Time Bazarr gets before subf2m is scraped (s)'], BACKOFF_HOURS: ['str', /^\d{1,3}(,\d{1,3}){0,5}$/, null, 'Retry back-off (hours, comma list)'],
  SUBF2M_GAP: ['num', 1, 120, 'Min seconds between subf2m requests'], NOTIFY: ['bool', 0, 1, 'Send a bot note when a subtitle was added'],
};
const subfaOverrides = () => { try { return JSON.parse(fs.readFileSync(SUBFA_FILE, 'utf8')); } catch { return {}; } };
let subfaEnvCache = { t: 0, env: {} };
async function subfaBase() {
  if (Date.now() - subfaEnvCache.t < 60000) return subfaEnvCache.env;
  const env = {};
  try { const j = await ctl.docker('GET', '/containers/subfa/json'); for (const e of (j.Config && j.Config.Env) || []) { const i = e.indexOf('='); const k = e.slice(0, i); if (SUBFA_KEYS[k]) env[k] = e.slice(i + 1); } } catch {}
  if (!('ENABLED' in env)) env.ENABLED = '1';
  subfaEnvCache = { t: Date.now(), env }; return env;
}
function subfaCoerce(k, v) {
  const d = SUBFA_KEYS[k]; if (!d) throw bad('unknown subfa setting ' + k);
  if (d[0] === 'bool') return v === true || v === 'true' || v === 1 || v === '1' ? '1' : '0';
  if (d[0] === 'str') { if (!d[1].test(String(v))) throw bad(`${k}: invalid format`); return String(v); }
  const n = Number(v); if (!Number.isFinite(n) || n < d[1] || n > d[2]) throw bad(`${k} must be between ${d[1]} and ${d[2]}`);
  return String(d[0] === 'int' ? Math.round(n) : n);
}
function subfaWrite(obj) {
  const tmp = SUBFA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, SUBFA_FILE);
}

module.exports = { MASK, indexers, indexerSchema, indexerAdd, indexerUpdate, indexerTest, indexerGet, indexerRemove,
  subtitleProviders, setEnabledProviders, configureProvider, bazarrSettings,
  QB_KEYS, qbitPrefs, qbitCoerce, qbitSet, qbitAltMode, qbitToggleAlt,
  arrProfiles, arrRootFolders, arrAddRootFolder,
  SUBFA_KEYS, SUBFA_FILE, subfaOverrides, subfaBase, subfaCoerce, subfaWrite };
