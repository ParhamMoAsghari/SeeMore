'use strict';
// Permission model shared by every interface (Telegram/Bale bot, web panel, API) — pure functions over SQLite.
//
// Schema (db.js):
//   acl_users(uid, name, username, perms JSON array, expires ms|null, status active|revoked|expired,
//             added, added_by, note, updated, last_seen)
//   acl_invites(code, perms JSON, grant_dur ms|null, grant_until ms|null, expires ms (code validity),
//               created, created_by, used_by, used_at, note)       one-time codes
//   audit(id, t, uid, perm, action, detail)
// The owner (OWNER env / config CHAT) always has every permission plus 'admin'. A grant is usable when
// status='active' and (expires is null or > now). sweep() turns elapsed grants into 'expired'.
const crypto = require('crypto');
const DB = require('./db');

const PERMS = [
  ['request', '🔎 جست‌وجو و درخواست دانلود'],
  ['library', '🎬 مشاهده‌ی کتابخانه'],
  ['lib_delete', '🗑 حذف از کتابخانه'],
  ['downloads', '📥 دانلودها و کنترل qBittorrent'],
  ['server', '⚙️ وضعیت سرور'],
  ['calendar', '📅 تقویم پخش'],
  ['notify', '🔔 دریافت اعلان‌ها'],
  ['usb_view', '💾 مشاهده‌ی حافظه‌های خارجی'],
  ['usb_copy', '📥 کپی روی حافظه‌ی خارجی'],
  ['usb_import', '📤 انتقال از حافظه به سرور'],
  ['usb_manage', '✂️ مدیریت فایل‌های حافظه (جابه‌جایی، تغییر نام، حذف)'],
  ['files', '🗂 مرور فایل‌های سرور و مشخصات'],
  ['links', '🔗 ساخت لینک دانلود'],
  // single sign-on: which services the panel may sign this user in to (see sso.js)
  ['svc.jellyfin', '🔑 ورود به Jellyfin'],
  ['svc.seerr', '🔑 ورود به Seerr'],
  ['svc.radarr', '🔑 ورود به Radarr'],
  ['svc.sonarr', '🔑 ورود به Sonarr'],
  ['svc.prowlarr', '🔑 ورود به Prowlarr'],
  ['svc.bazarr', '🔑 ورود به Bazarr'],
  ['svc.qbit', '🔑 ورود به qBittorrent'],
];
const KEYS = PERMS.map((p) => p[0]);
const LABEL = Object.fromEntries(PERMS);
const PRESETS = {
  viewer: ['library', 'calendar', 'notify', 'svc.jellyfin'],
  family: ['request', 'library', 'downloads', 'calendar', 'notify', 'usb_view', 'usb_copy', 'links', 'svc.jellyfin', 'svc.seerr'],
  full: KEYS.slice(),
};

let OWNER = Number(process.env.ALLOWED_CHAT || 0);
const setOwner = (id) => { OWNER = Number(id); };
const isOwner = (uid) => Number(uid) === OWNER;
const now = () => Date.now();
const parse = (r) => (r ? { ...r, perms: JSON.parse(r.perms || '[]') } : null);

function getUser(uid) { return parse(DB.one('SELECT * FROM acl_users WHERE uid=?', Number(uid))); }
function isActive(u) { return !!u && u.status === 'active' && (u.expires == null || u.expires > now()); }
// feature flags (settings 'features.*') switch whole areas off for everyone, owner included
const FEATURE = { request: 'features.requests', usb_view: 'features.usb', usb_copy: 'features.usb', usb_import: 'features.usb_import', usb_manage: 'features.usb_manage', files: 'features.files', links: 'features.links', notify: 'features.notify' };
function featureOn(p) { const f = FEATURE[p]; if (!f) return true; try { const S = require('./settings'); return S.get(f) !== false && (p !== 'usb_import' && p !== 'usb_manage' && p !== 'usb_copy' || S.get('features.usb') !== false); } catch { return true; } }
function permsOf(uid) {
  let base;
  if (isOwner(uid)) base = [...KEYS, 'admin'];
  else { const u = getUser(uid); base = isActive(u) ? u.perms.filter((p) => KEYS.includes(p)) : []; }
  return new Set(base.filter(featureOn));
}
const can = (uid, perm) => (perm === 'any' ? isOwner(uid) || isActive(getUser(uid)) : permsOf(uid).has(perm));
const allowed = (uid) => isOwner(uid) || isActive(getUser(uid));

function list() { return DB.all('SELECT * FROM acl_users ORDER BY status, added DESC').map(parse); }
function grant({ uid, perms, expires = null, name = null, username = null, by = OWNER, note = null }) {
  uid = Number(uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('شناسه‌ی کاربر نامعتبر است');
  if (isOwner(uid)) throw new Error('مالک ربات همیشه دسترسی کامل دارد');
  perms = (perms || []).filter((p) => KEYS.includes(p));
  const t = now();
  DB.run(`INSERT INTO acl_users(uid,name,username,perms,expires,status,added,added_by,note,updated) VALUES(?,?,?,?,?,'active',?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET perms=excluded.perms, expires=excluded.expires, status='active', note=COALESCE(excluded.note, note),
    name=COALESCE(excluded.name, name), username=COALESCE(excluded.username, username), updated=excluded.updated`,
  uid, name, username, JSON.stringify(perms), expires, t, by, note, t);
  audit(by, 'admin', 'grant', `${uid} ${perms.join(',')} ${expires || '∞'}`);
  return getUser(uid);
}
function update(uid, patch, by = OWNER) {
  const u = getUser(uid); if (!u) throw new Error('کاربر پیدا نشد');
  const perms = patch.perms ? patch.perms.filter((p) => KEYS.includes(p)) : u.perms;
  const expires = 'expires' in patch ? patch.expires : u.expires;
  const status = patch.status || (('expires' in patch) && u.status === 'expired' ? 'active' : u.status);
  DB.run('UPDATE acl_users SET perms=?, expires=?, status=?, note=COALESCE(?, note), updated=? WHERE uid=?', JSON.stringify(perms), expires, status, patch.note ?? null, now(), Number(uid));
  audit(by, 'admin', 'update', `${uid} ${JSON.stringify({ perms: patch.perms ? perms : undefined, expires: 'expires' in patch ? expires : undefined, status: patch.status })}`);
  return getUser(uid);
}
const revoke = (uid, by = OWNER) => update(uid, { status: 'revoked' }, by);
const extend = (uid, expires, by = OWNER) => update(uid, { expires, status: 'active' }, by);
function remove(uid, by = OWNER) { DB.run('DELETE FROM acl_users WHERE uid=?', Number(uid)); audit(by, 'admin', 'delete', String(uid)); }
function touch(uid, name, username) {
  if (isOwner(uid)) return;
  DB.run('UPDATE acl_users SET last_seen=?, name=COALESCE(?, name), username=COALESCE(?, username) WHERE uid=?', now(), name || null, username || null, Number(uid));
}

// one-time invite codes
function createInvite({ perms, grantDur = null, grantUntil = null, ttl = 86400000, by = OWNER, note = null }) {
  const code = crypto.randomBytes(9).toString('base64url');
  DB.run('INSERT INTO acl_invites(code,perms,grant_dur,grant_until,expires,created,created_by,note) VALUES(?,?,?,?,?,?,?,?)',
    code, JSON.stringify((perms || []).filter((p) => KEYS.includes(p))), grantDur, grantUntil, now() + ttl, now(), by, note);
  audit(by, 'admin', 'invite', `${(perms || []).join(',')}`);
  return getInvite(code);
}
function getInvite(code) { const r = DB.one('SELECT * FROM acl_invites WHERE code=?', String(code)); return r ? { ...r, perms: JSON.parse(r.perms) } : null; }
function invites() { return DB.all('SELECT * FROM acl_invites WHERE used_by IS NULL AND expires>? ORDER BY created DESC', now()).map((r) => ({ ...r, perms: JSON.parse(r.perms) })); }
function deleteInvite(code, by = OWNER) { DB.run('DELETE FROM acl_invites WHERE code=?', String(code)); audit(by, 'admin', 'invite_delete', ''); }
function redeem(code, { uid, name, username }) {
  return DB.tx(() => {
    const inv = getInvite(code);
    if (!inv || inv.used_by || inv.expires < now()) return null;
    if (isOwner(uid)) return null;
    const expires = inv.grant_until || (inv.grant_dur ? now() + inv.grant_dur : null);
    DB.run('UPDATE acl_invites SET used_by=?, used_at=? WHERE code=?', Number(uid), now(), code);
    const u = grant({ uid, perms: inv.perms, expires, name, username, by: inv.created_by, note: 'invite' });
    audit(uid, 'any', 'redeem', '');
    return u;
  });
}

// elapsed grants -> 'expired'; returns the users that just expired (caller notifies)
function sweep() {
  const rows = DB.all("SELECT * FROM acl_users WHERE status='active' AND expires IS NOT NULL AND expires<=?", now()).map(parse);
  if (rows.length) DB.tx(() => { for (const u of rows) { DB.run("UPDATE acl_users SET status='expired', updated=? WHERE uid=?", now(), u.uid); audit(OWNER, 'admin', 'expired', String(u.uid)); } });
  DB.run('DELETE FROM acl_invites WHERE expires < ?', now() - 7 * 86400000);
  return rows;
}
// owner + active users that hold perm
function recipients(perm) {
  if (!featureOn(perm)) return [];
  const out = [OWNER];
  for (const u of DB.all("SELECT * FROM acl_users WHERE status='active'").map(parse)) if (isActive(u) && u.perms.includes(perm)) out.push(u.uid);
  return out;
}

function audit(uid, perm, action, detail) {
  try {
    DB.run('INSERT INTO audit(t,uid,perm,action,detail) VALUES(?,?,?,?,?)', now(), uid == null ? null : Number(uid), perm || null, String(action || '').slice(0, 60), detail == null ? null : String(detail).slice(0, 300));
    if (Math.random() < 0.01) DB.run('DELETE FROM audit WHERE id < (SELECT MAX(id) - 20000 FROM audit)');
  } catch {}
}
const auditFor = (uid, limit = 20) => DB.all('SELECT * FROM audit WHERE uid=? ORDER BY id DESC LIMIT ?', Number(uid), limit);
const auditAll = (limit = 30) => DB.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', limit);

// Bot callback action -> permission. Unknown actions are owner-only.
const EXACT = {
  noop: 'any', close: 'any', menu: 'any',
  n: 'request', sk: 'request', a: 'request', mo: 'request', t: 'request', ts: 'request', q: 'request', y: 'request', x: 'request',
  lr: 'request', lss: 'request', lrl: 'request', rel: 'request', rg: 'request',
  lib: 'library', lp: 'library', lf: 'library', li: 'library', lit: 'library', lse: 'library', new: 'library',
  lx: 'lib_delete', lxx: 'lib_delete',
  st: 'downloads', dq: 'downloads',
  srv: 'server', idx: 'server', cal: 'calendar',
  ud: 'usb_view', ub: 'usb_view', ubo: 'usb_view', ubp: 'usb_view', ubu: 'usb_view', ubf: 'usb_view', ubm: 'usb_view', ue: 'usb_view',
  ubx: 'usb_manage', ubxx: 'usb_manage', ubD: 'usb_manage', ubDD: 'usb_manage',
};
function permFor(action) {
  if (EXACT[action]) return EXACT[action];
  if (/^uj/.test(action)) return 'any';        // job controls: checked against the job owner in the handler
  if (/^ui/.test(action)) return 'usb_import';
  if (/^um/.test(action)) return 'usb_manage';
  if (/^uc/.test(action)) return 'usb_copy';
  if (/^fs/.test(action)) return 'files';
  if (/^lk/.test(action)) return 'links';
  if (/^ac/.test(action)) return 'admin';
  return 'admin';
}

module.exports = { PERMS, KEYS, LABEL, PRESETS, setOwner, isOwner, owner: () => OWNER, getUser, isActive, permsOf, can, allowed, list, grant, update, revoke, extend, remove, touch,
  createInvite, getInvite, invites, deleteInvite, redeem, sweep, recipients, audit, auditFor, auditAll, permFor, featureOn, FEATURE };
