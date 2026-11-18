'use strict';
// Settings catalog + apply engine with change classes, confirmation, history and rollback.
//
// Classes (shown in the panel next to every setting):
//   hot      applies immediately, no restart (seemore settings, qBittorrent, Prowlarr/Bazarr ops)
//   reload   the affected container is restarted through the restricted Docker socket proxy
//   recreate the container is recreated by the host helper (compose env: ports, memory, host binds)
//   caddy    Caddy site blocks are regenerated, validated and gracefully reloaded by the host helper
// Disruptive classes (reload / recreate / caddy) need {confirm: true}. Every change is written to
// settings_history (old -> new, class, status) and can be rolled back from there.
const fs = require('fs');
const path = require('path');
const DB = require('../db');
const SET = require('../settings');
const PV = require('./providers');
const ctl = require('./ctl');
const caddy = require('./caddy');
const U = require('../util');

const SELF = ctl.SELF;
function classOf(key) {
  if (key.startsWith('domains.')) return { cls: 'caddy', target: 'caddy' };
  if (key === 'net.api_port') return { cls: 'recreate', target: SELF, env: 'API_PORT', caddy: true };
  if (key === 'net.links_port') return { cls: 'recreate', target: SELF, env: 'DL_PORT', caddy: true };
  if (key === 'container.mem_limit') return { cls: 'recreate', target: SELF, env: 'SEEMORE_MEM_LIMIT' };
  if (key === 'container.panel_bind') return { cls: 'recreate', target: SELF, env: 'SEEMORE_PANEL_BIND' };
  if (key === 'bot.messenger' || key === 'bot.token_env' || key.startsWith('bot.update_mode') || key.startsWith('bot.webhook_')) return { cls: 'reload', target: SELF };
  if (key.startsWith('subfa.')) return { cls: 'reload', target: 'subfa' };
  return { cls: 'hot', target: null };
}
const groupOf = (key) => key.split('.')[0];

async function catalog({ external = true } = {}) {
  const out = SET.all().map((s) => ({ ...s, scope: 'seemore', group: groupOf(s.key), ...classOf(s.key) }));
  if (external) {
    try {
      const ov = PV.subfaOverrides(); const base = await PV.subfaBase();
      for (const [k, d] of Object.entries(PV.SUBFA_KEYS)) out.push({ key: `subfa.${k}`, scope: 'subfa', group: 'subfa', type: d[0] === 'num' ? 'num' : d[0], value: ov[k] ?? base[k] ?? null, default: base[k] ?? null, overridden: k in ov, description: d[3], spec: d[0] === 'str' ? { re: String(d[1]) } : { min: d[1], max: d[2] }, ...classOf(`subfa.${k}`) });
    } catch (e) { out.push({ key: 'subfa', scope: 'subfa', group: 'subfa', error: e.message }); }
    try {
      const p = await PV.qbitPrefs();
      for (const [k, d] of Object.entries(PV.QB_KEYS)) out.push({ key: `qbit.${k}`, scope: 'qbit', group: 'qbit', type: d[0], value: p[k], default: null, description: d[3], spec: d[0] === 'bool' ? undefined : { min: d[1], max: d[2] }, ...classOf(`qbit.${k}`) });
    } catch (e) { out.push({ key: 'qbit', scope: 'qbit', group: 'qbit', error: e.message }); }
  }
  return out;
}

function hist(row) {
  const r = DB.run('INSERT INTO settings_history(t,by,key,scope,cls,old,new,status,detail,rollback_of) VALUES(?,?,?,?,?,?,?,?,?,?)',
    Date.now(), row.by ?? null, row.key, row.scope, row.cls, JSON.stringify(row.old ?? null), JSON.stringify(row.new ?? null), row.status, row.detail ? JSON.stringify(row.detail).slice(0, 2000) : null, row.rollbackOf ?? null);
  return Number(r.lastInsertRowid);
}
const histSet = (ids, status, detail) => { for (const id of ids) DB.run('UPDATE settings_history SET status=?, detail=COALESCE(?, detail) WHERE id=?', status, detail ? JSON.stringify(detail).slice(0, 2000) : null, id); };
const history = (limit = 100, key = null) => DB.all(`SELECT * FROM settings_history ${key ? 'WHERE key=?' : ''} ORDER BY id DESC LIMIT ?`, ...(key ? [key] : []), limit)
  .map((r) => ({ ...r, old: JSON.parse(r.old), new: JSON.parse(r.new), detail: r.detail ? JSON.parse(r.detail) : null, rollbackable: ['seemore', 'subfa', 'qbit', 'prowlarr', 'bazarr'].includes(r.scope) && !String(r.key).startsWith('arr.') }));
// external ops (Prowlarr / Bazarr) record themselves here
const record = (by, key, scope, old, nw, detail) => hist({ by, key, scope, cls: 'hot', old, new: nw, status: 'applied', detail });

async function apply(uid, changes, { confirm = false, rollbackOf = null } = {}) {
  if (!Array.isArray(changes) || !changes.length) throw Object.assign(new Error('no changes'), { status: 400 });
  const cat = await catalog();
  const byKey = new Map(cat.map((e) => [e.key, e]));
  const plan = [];
  for (const c of changes) {
    const key = String(c.key || '');
    const e = byKey.get(key); if (!e || e.error) throw Object.assign(new Error(`unknown setting ${key}`), { status: 400 });
    let v;
    let reset = false;
    if (e.scope === 'seemore' && c.value === null) { reset = true; v = SET.fallback(key); } // null = drop the override (env / default)
    else if (e.scope === 'seemore') v = SET.validate(key, SET.coerce(e.type, c.value));
    else if (e.scope === 'subfa') v = c.value === null ? null : PV.subfaCoerce(key.slice(6), c.value);
    else if (e.scope === 'qbit') v = PV.qbitCoerce(key.slice(5), c.value);
    if (JSON.stringify(v) === JSON.stringify(e.value) && !(e.scope === 'subfa' && v === null && e.overridden) && !(reset && e.overridden)) continue;
    plan.push({ e, key, old: e.value, v, reset });
  }
  if (!plan.length) return { applied: [], actions: [], unchanged: true };
  const disruptive = plan.filter((p) => p.e.cls !== 'hot');
  if (disruptive.length && !confirm) {
    throw Object.assign(new Error('confirmation required'), { status: 409, needsConfirm: true, plan: disruptive.map((p) => ({ key: p.key, cls: p.e.cls, target: p.e.target })) });
  }
  // 1. write values
  const ids = new Map();
  const subfa = PV.subfaOverrides(); let subfaDirty = false; const qb = {};
  for (const p of plan) {
    if (p.e.scope === 'seemore') { if (p.reset) SET.reset(p.key); else SET.set(p.key, p.v, uid); }
    else if (p.e.scope === 'subfa') { const k = p.key.slice(6); if (p.v === null) delete subfa[k]; else subfa[k] = p.v; subfaDirty = true; }
    else if (p.e.scope === 'qbit') qb[p.key.slice(5)] = p.v;
    ids.set(p.key, hist({ by: uid, key: p.key, scope: p.e.scope, cls: p.e.cls, old: p.old, new: p.v, status: p.e.cls === 'hot' ? 'applied' : 'pending', rollbackOf }));
  }
  if (subfaDirty) PV.subfaWrite(subfa);
  if (Object.keys(qb).length) await PV.qbitSet(qb);
  require('../perms').audit(uid, 'admin', 'settings', plan.map((p) => `${p.key}=${JSON.stringify(p.v)}`).join(' ').slice(0, 280));
  // 2. follow-up actions
  const actions = [];
  const keysOf = (pred) => plan.filter(pred).map((p) => ids.get(p.key));
  // caddy (domains) — revert the values if Caddy refuses the config
  const caddyPlan = plan.filter((p) => p.e.cls === 'caddy');
  if (caddyPlan.length) {
    try { const r = await caddy.apply(); actions.push({ type: 'caddy-reload', ok: true, changed: r.changed }); histSet(keysOf((p) => p.e.cls === 'caddy'), 'applied', { caddy: 'reloaded' }); }
    catch (e) {
      for (const p of caddyPlan) SET.set(p.key, p.old, uid);
      histSet(keysOf((p) => p.e.cls === 'caddy'), 'reverted', { error: e.message });
      actions.push({ type: 'caddy-reload', ok: false, error: e.message, reverted: true });
    }
  }
  // reload: restart containers via the socket proxy (others first, our own container last)
  const reloads = [...new Set(plan.filter((p) => p.e.cls === 'reload').map((p) => p.e.target))].sort((a, b) => (a === SELF) - (b === SELF));
  for (const t of reloads) {
    const k = keysOf((p) => p.e.cls === 'reload' && p.e.target === t);
    try { const r = await ctl.restart(t, { by: uid }); actions.push({ type: 'restart', target: t, ok: true, status: r.status }); histSet(k, r.status === 'scheduled' ? 'applied' : 'applied', { restart: t, ctl: r.id }); }
    catch (e) { histSet(k, 'failed', { error: e.message }); actions.push({ type: 'restart', target: t, ok: false, error: e.message }); }
  }
  // recreate: host helper updates the allowlisted compose env keys and recreates the container
  const rec = plan.filter((p) => p.e.cls === 'recreate');
  if (rec.length) {
    const env = {}; for (const p of rec) env[p.e.env] = String(p.v);
    const withCaddy = rec.some((p) => p.e.caddy);
    try {
      if (withCaddy) { const txt = caddy.render(); fs.writeFileSync(caddy.FILE + '.tmp', txt); fs.renameSync(caddy.FILE + '.tmp', caddy.FILE); }
      const self = rec.every((p) => p.e.target === SELF);
      const r = await ctl.hostRequest('recreate', SELF, { env, then: withCaddy ? 'caddy-reload' : null }, self ? 0 : 120000);
      histSet(keysOf((p) => p.e.cls === 'recreate'), self ? 'pending' : 'applied', { ctl: r.id, env: Object.keys(env) });
      actions.push({ type: 'recreate', target: SELF, ok: true, status: r.status, id: r.id });
    } catch (e) {
      for (const p of rec) SET.set(p.key, p.old, uid);
      histSet(keysOf((p) => p.e.cls === 'recreate'), 'reverted', { error: e.message });
      actions.push({ type: 'recreate', target: SELF, ok: false, error: e.message, reverted: true });
    }
  }
  return { applied: plan.map((p) => ({ key: p.key, old: p.old, new: p.v, cls: p.e.cls, history: ids.get(p.key) })), actions };
}

async function rollback(uid, id, { confirm = false } = {}) {
  const h = DB.one('SELECT * FROM settings_history WHERE id=?', Number(id));
  if (!h) throw Object.assign(new Error('history entry not found'), { status: 404 });
  const old = JSON.parse(h.old);
  if (['seemore', 'subfa', 'qbit'].includes(h.scope)) return apply(uid, [{ key: h.key, value: old }], { confirm, rollbackOf: h.id });
  if (h.scope === 'prowlarr') {
    const m = /^prowlarr\.indexer:(\d+)$/.exec(h.key); if (!m || !old) throw Object.assign(new Error('this change can not be rolled back'), { status: 400 });
    const r = await PV.indexerUpdate(Number(m[1]), old);
    hist({ by: uid, key: h.key, scope: 'prowlarr', cls: 'hot', old: r.before, new: r.after, status: 'applied', rollbackOf: h.id });
    return { applied: [{ key: h.key, old: r.before, new: r.after }], actions: [] };
  }
  if (h.scope === 'bazarr') {
    if (h.key === 'bazarr.enabled_providers') { const r = await PV.setEnabledProviders(old); hist({ by: uid, key: h.key, scope: 'bazarr', cls: 'hot', old: r.before, new: r.after, status: 'applied', rollbackOf: h.id }); return { applied: [{ key: h.key, old: r.before, new: r.after }], actions: [] }; }
    const m = /^bazarr\.provider:([a-z0-9_]+)$/.exec(h.key);
    if (m && old) { const r = await PV.configureProvider(m[1], old); hist({ by: uid, key: h.key, scope: 'bazarr', cls: 'hot', old: r.before, new: r.after, status: 'applied', rollbackOf: h.id }); return { applied: [{ key: h.key }], actions: [] }; }
  }
  throw Object.assign(new Error('this change can not be rolled back'), { status: 400 });
}

// boot: settle history rows whose host-helper request finished while we were restarting
function reconcile() {
  const dir = path.join(process.env.CTL_DIR || '/seemorectl', 'results');
  for (const r of DB.all("SELECT * FROM ctl_requests WHERE status='pending'")) {
    const f = path.join(dir, `${r.id}.json`);
    if (!fs.existsSync(f)) { if (Date.now() - r.t > 600000) DB.run("UPDATE ctl_requests SET status='lost', done=? WHERE id=?", Date.now(), r.id); continue; }
    let res; try { res = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    try { fs.unlinkSync(f); } catch {}
    DB.run('UPDATE ctl_requests SET status=?, result=?, done=? WHERE id=?', res.ok ? 'ok' : 'failed', JSON.stringify(res).slice(0, 4000), Date.now(), r.id);
  }
  for (const h of DB.all("SELECT * FROM settings_history WHERE status='pending'")) {
    const d = h.detail ? JSON.parse(h.detail) : {};
    const c = d.ctl ? DB.one('SELECT * FROM ctl_requests WHERE id=?', d.ctl) : null;
    if (c && c.status === 'ok') DB.run("UPDATE settings_history SET status='applied' WHERE id=?", h.id);
    else if (c && (c.status === 'failed' || c.status === 'lost')) {
      DB.run("UPDATE settings_history SET status='reverted' WHERE id=?", h.id);
      if (h.scope === 'seemore') { try { SET.set(h.key, JSON.parse(h.old), h.by); } catch {} }
    }
    else if (!c && Date.now() - h.t > 600000) DB.run("UPDATE settings_history SET status='unknown' WHERE id=?", h.id);
  }
}

module.exports = { catalog, apply, rollback, history, record, reconcile, classOf };
