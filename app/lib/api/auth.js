'use strict';
// Panel authentication: local scrypt hashes, server-side sessions, lockout, CSRF.
//
// Owner account: username = PANEL_OWNER_USER (default JELLYFIN_USER), password = the shared app password.
// Its scrypt hash is derived from the env secret named by PANEL_OWNER_PASS_ENV (default JELLYFIN_PASS) on
// start-up and refreshed when that secret changes, so the panel uses the same password as the other
// systems without ever calling Jellyfin with guesses (Jellyfin locks accounts after failed attempts).
// Granted bot users can get their own panel account (owner sets username/password; scrypt-hashed).
//
// Sessions: random 256-bit id in an httpOnly SameSite=Strict cookie (Secure on HTTPS); only its sha256
// is stored. Every mutating request needs the X-CSRF-Token of the session and a same-origin Origin.
// Lockout: N failures for the same user+IP -> locked for M minutes; many failures from one IP -> IP blocked
// for an hour. Counters live in SQLite, so a restart does not reset them.
const crypto = require('crypto');
const DB = require('../db');
const P = require('../perms');
const SET = require('../settings');
const U = require('../util');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const hashPw = (pw) => new Promise((res, rej) => { const salt = crypto.randomBytes(16); crypto.scrypt(String(pw), salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(`scrypt$${SCRYPT.N}$${salt.toString('base64')}$${k.toString('base64')}`))); });
const verifyPw = (pw, h) => new Promise((res) => {
  const m = /^scrypt\$(\d+)\$([^$]+)\$([^$]+)$/.exec(h || ''); if (!m) return res(false);
  crypto.scrypt(String(pw), Buffer.from(m[2], 'base64'), 32, { ...SCRYPT, N: Number(m[1]) }, (e, k) => {
    if (e) return res(false); const want = Buffer.from(m[3], 'base64'); res(want.length === k.length && crypto.timingSafeEqual(want, k));
  });
});
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ownerUser = () => String(process.env.PANEL_OWNER_USER || process.env.JELLYFIN_USER || 'admin').toLowerCase();
const USER_RE = /^[a-z0-9._-]{3,32}$/;

// owner hash from the shared secret (fingerprint = HMAC so the secret itself is never stored)
async function syncOwner() {
  const secret = process.env[process.env.PANEL_OWNER_PASS_ENV || 'JELLYFIN_PASS'];
  const name = ownerUser();
  const row = DB.one('SELECT * FROM panel_accounts WHERE username=?', name);
  if (!secret) { if (!row) U.log('warn', 'panel: no owner password secret set; owner login disabled'); return; }
  const fp = crypto.createHmac('sha256', 'seemore-owner-fp').update(secret).digest('hex').slice(0, 24);
  if (row && row.source === 'panel') return;               // owner changed the password in the panel
  if (row && row.fp === fp && row.uid === P.owner()) return;
  const h = await hashPw(secret);
  DB.run(`INSERT INTO panel_accounts(username,uid,hash,source,fp,created,updated) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET uid=excluded.uid, hash=excluded.hash, source='env', fp=excluded.fp, updated=excluded.updated`, name, P.owner(), h, 'env', fp, Date.now(), Date.now());
  U.log('info', `panel: owner account '${name}' ${row ? 'updated from' : 'created from'} the shared password`);
}

// ---------- lockout ----------
function failState(k) { return DB.one('SELECT * FROM login_fail WHERE k=?', k); }
function lockedFor(user, ip) {
  const now = Date.now();
  for (const k of [`ui:${user}|${ip}`, `ip:${ip}`]) { const r = failState(k); if (r && r.locked_until && r.locked_until > now) return r.locked_until - now; }
  return 0;
}
function fail(user, ip) {
  const now = Date.now();
  const rules = [[`ui:${user}|${ip}`, SET.get('panel.lock_after'), SET.get('panel.lock_minutes') * 60000, SET.get('panel.lock_minutes') * 60000], [`ip:${ip}`, SET.get('panel.ip_lock_after'), 3600000, 3600000]];
  DB.tx(() => {
    for (const [k, max, win, lock] of rules) {
      const r = failState(k);
      if (!r || now - r.first > win) DB.run('INSERT INTO login_fail(k,n,first,locked_until) VALUES(?,1,?,NULL) ON CONFLICT(k) DO UPDATE SET n=1, first=excluded.first, locked_until=NULL', k, now);
      else { const n = r.n + 1; DB.run('UPDATE login_fail SET n=?, locked_until=? WHERE k=?', n, n >= max ? now + lock : r.locked_until, k); }
    }
  });
  if (Math.random() < 0.05) DB.run('DELETE FROM login_fail WHERE first < ? AND (locked_until IS NULL OR locked_until < ?)', now - 86400000, now);
}
const clearFails = (user, ip) => DB.run('DELETE FROM login_fail WHERE k=?', `ui:${user}|${ip}`);

// ---------- sessions ----------
async function login(username, password, { ip, ua }) {
  const user = String(username || '').trim().toLowerCase().slice(0, 64);
  const wait = lockedFor(user, ip);
  if (wait) { P.audit(null, 'panel', 'login_locked', `${user} ${ip}`); return { ok: false, locked: Math.ceil(wait / 1000) }; }
  const row = USER_RE.test(user) ? DB.one('SELECT * FROM panel_accounts WHERE username=? AND disabled=0', user) : null;
  // constant-ish work even for unknown users
  const ok = row ? await verifyPw(String(password || ''), row.hash) : (await verifyPw('x', 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
  if (!ok || !(P.isOwner(row.uid) || P.allowed(row.uid))) {
    fail(user, ip); await U.sleep(400 + Math.random() * 300);
    P.audit(row ? row.uid : null, 'panel', 'login_failed', `${user} ${ip}`.slice(0, 120));
    const left = lockedFor(user, ip);
    return { ok: false, locked: left ? Math.ceil(left / 1000) : 0 };
  }
  clearFails(user, ip);
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  DB.run('INSERT INTO panel_sessions(id,uid,username,csrf,created,expires,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?,?,?)', sha(id), row.uid, user, csrf, now, now + SET.get('panel.session_hours') * 3600000, now, ip, String(ua || '').slice(0, 200));
  DB.run('UPDATE panel_accounts SET last_login=? WHERE username=?', now, user);
  DB.run('DELETE FROM panel_sessions WHERE expires < ?', now);
  P.audit(row.uid, 'panel', 'login', ip);
  return { ok: true, sid: id, csrf, uid: row.uid, username: user };
}
function session(sid) {
  if (!sid) return null;
  const r = DB.one('SELECT * FROM panel_sessions WHERE id=?', sha(sid));
  if (!r) return null;
  const now = Date.now();
  if (r.expires < now) { DB.run('DELETE FROM panel_sessions WHERE id=?', r.id); return null; }
  if (!P.isOwner(r.uid) && !P.allowed(r.uid)) return null;            // grant revoked / expired
  const acc = DB.one('SELECT disabled FROM panel_accounts WHERE username=?', r.username);
  if (!acc || acc.disabled) return null;
  if (now - r.last_seen > 60000) DB.run('UPDATE panel_sessions SET last_seen=?, expires=? WHERE id=?', now, now + SET.get('panel.session_hours') * 3600000, r.id);
  return r;
}
const logout = (sid) => { if (sid) DB.run('DELETE FROM panel_sessions WHERE id=?', sha(sid)); };
const sessionsOf = (uid) => DB.all('SELECT id, created, last_seen, expires, ip, ua FROM panel_sessions WHERE uid=? ORDER BY last_seen DESC', uid).map((r) => ({ ...r, id: r.id.slice(0, 10) }));
const revokeSessions = (uid, keepHashPrefix = null) => DB.run(`DELETE FROM panel_sessions WHERE uid=? ${keepHashPrefix ? 'AND substr(id,1,10)<>?' : ''}`, ...(keepHashPrefix ? [uid, keepHashPrefix] : [uid]));

// ---------- accounts ----------
const accounts = () => DB.all('SELECT username, uid, source, disabled, created, updated, last_login FROM panel_accounts ORDER BY created');
async function setAccount({ uid, username, password, by }) {
  username = String(username).trim().toLowerCase();
  if (!USER_RE.test(username)) throw Object.assign(new Error('نام کاربری: ۳ تا ۳۲ حرف کوچک انگلیسی، عدد، . _ -'), { status: 400 });
  if (String(password).length < 10) throw Object.assign(new Error('رمز باید دست‌کم ۱۰ نویسه باشد'), { status: 400 });
  if (!P.isOwner(uid) && !P.getUser(uid)) throw Object.assign(new Error('این کاربر دسترسی ربات ندارد'), { status: 400 });
  const ex = DB.one('SELECT * FROM panel_accounts WHERE username=?', username);
  if (ex && ex.uid !== uid) throw Object.assign(new Error('این نام کاربری مال کاربر دیگری است'), { status: 409 });
  if (!P.isOwner(uid)) { const other = DB.one('SELECT username FROM panel_accounts WHERE uid=? AND username<>?', uid, username); if (other) DB.run('DELETE FROM panel_accounts WHERE username=?', other.username); }
  const h = await hashPw(password);
  DB.run(`INSERT INTO panel_accounts(username,uid,hash,source,created,updated) VALUES(?,?,?,'panel',?,?)
    ON CONFLICT(username) DO UPDATE SET hash=excluded.hash, source='panel', disabled=0, updated=excluded.updated`, username, uid, h, Date.now(), Date.now());
  revokeSessions(uid);
  P.audit(by, 'admin', 'panel_account', `${username} -> ${uid}`);
  return { username, uid };
}
function removeAccount(username, by) {
  const r = DB.one('SELECT * FROM panel_accounts WHERE username=?', username);
  if (!r) throw Object.assign(new Error('not found'), { status: 404 });
  if (P.isOwner(r.uid) && r.username === ownerUser()) throw Object.assign(new Error('owner account can not be removed'), { status: 400 });
  DB.run('DELETE FROM panel_accounts WHERE username=?', username); revokeSessions(r.uid);
  P.audit(by, 'admin', 'panel_account_delete', username);
  return true;
}
async function changeOwnPassword(sess, current, next) {
  const row = DB.one('SELECT * FROM panel_accounts WHERE username=?', sess.username);
  if (!row || !(await verifyPw(current, row.hash))) throw Object.assign(new Error('رمز فعلی درست نیست'), { status: 400 });
  if (String(next).length < 10) throw Object.assign(new Error('رمز باید دست‌کم ۱۰ نویسه باشد'), { status: 400 });
  DB.run("UPDATE panel_accounts SET hash=?, source='panel', updated=? WHERE username=?", await hashPw(next), Date.now(), row.username);
  revokeSessions(row.uid, sess.id.slice(0, 10));
  P.audit(row.uid, 'panel', 'password_change', '');
  return true;
}
// owner can go back to "same password as the other systems"
async function resetOwnerToShared(by) { DB.run("UPDATE panel_accounts SET source='env', fp=NULL WHERE username=?", ownerUser()); await syncOwner(); P.audit(by, 'admin', 'owner_pw_shared', ''); return true; }

module.exports = { syncOwner, login, session, logout, sessionsOf, revokeSessions, accounts, setAccount, removeAccount, changeOwnPassword, resetOwnerToShared, ownerUser, hashPw, verifyPw };
