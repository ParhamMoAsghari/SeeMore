'use strict';
// SQLite (node:sqlite, WAL, synchronous=FULL). Durable state: jobs + per-file manifests, permissions,
// audit log, download links, CRC cache and the small UI key/value state. Every write is a transaction.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, uid INTEGER, title TEXT,
  data TEXT NOT NULL DEFAULT '{}', err TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  started INTEGER, finished INTEGER);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS job_files (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  src TEXT NOT NULL, dst TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  hash TEXT, skip TEXT, role TEXT, grp INTEGER, err TEXT, PRIMARY KEY (job_id, idx));
CREATE TABLE IF NOT EXISTS acl_users (
  uid INTEGER PRIMARY KEY, name TEXT, username TEXT, perms TEXT NOT NULL DEFAULT '[]', expires INTEGER,
  status TEXT NOT NULL DEFAULT 'active', added INTEGER NOT NULL, added_by INTEGER, note TEXT,
  updated INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS acl_invites (
  code TEXT PRIMARY KEY, perms TEXT NOT NULL, grant_dur INTEGER, grant_until INTEGER, expires INTEGER NOT NULL,
  created INTEGER NOT NULL, created_by INTEGER, used_by INTEGER, used_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, uid INTEGER, perm TEXT, action TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS audit_uid ON audit(uid, t);
CREATE TABLE IF NOT EXISTS links (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, items TEXT NOT NULL, total INTEGER NOT NULL,
  expires INTEGER, max_dl INTEGER, downloads INTEGER NOT NULL DEFAULT 0, creator INTEGER, created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0, rar_status TEXT, rar_size INTEGER, rar_err TEXT, last_dl INTEGER, notified INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS link_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, t INTEGER, ip TEXT, range TEXT, status INTEGER, bytes INTEGER, ua TEXT);
CREATE INDEX IF NOT EXISTS link_hits_token ON link_hits(token);
CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, t INTEGER NOT NULL, type TEXT NOT NULL,
  state TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, seq);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, uid INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', dedupe TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, sent_at INTEGER, msg_id INTEGER, err TEXT);
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(status, next_at);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL, by INTEGER);
CREATE TABLE IF NOT EXISTS crc_cache (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, crc INTEGER);
-- seemore API / web panel
CREATE TABLE IF NOT EXISTS panel_accounts (
  username TEXT PRIMARY KEY, uid INTEGER NOT NULL, hash TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'panel',
  fp TEXT, disabled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE IF NOT EXISTS panel_sessions (
  id TEXT PRIMARY KEY, uid INTEGER NOT NULL, username TEXT, csrf TEXT NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS panel_sessions_uid ON panel_sessions(uid);
CREATE TABLE IF NOT EXISTS login_fail (k TEXT PRIMARY KEY, n INTEGER NOT NULL, first INTEGER NOT NULL, locked_until INTEGER);
CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, by INTEGER, key TEXT NOT NULL, scope TEXT NOT NULL,
  cls TEXT NOT NULL, old TEXT, new TEXT, status TEXT NOT NULL, detail TEXT, rollback_of INTEGER);
-- single sign-on: parent-domain cookie tokens bound to a panel session (see sso.js)
CREATE TABLE IF NOT EXISTS sso_tokens (h TEXT PRIMARY KEY, sess TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sso_tokens_sess ON sso_tokens(sess);
CREATE TABLE IF NOT EXISTS ctl_requests (
  id TEXT PRIMARY KEY, t INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, status TEXT NOT NULL, result TEXT, done INTEGER);
`;

let db = null;
function open(file) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  // additive migrations (ALTER TABLE ADD COLUMN is idempotent here: errors for existing columns are ignored)
  for (const sql of [
    'ALTER TABLE jobs ADD COLUMN idem_key TEXT', 'ALTER TABLE jobs ADD COLUMN phase TEXT', 'ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE jobs ADD COLUMN recovery TEXT', 'ALTER TABLE job_files ADD COLUMN idem_key TEXT', 'ALTER TABLE job_files ADD COLUMN verified INTEGER',
  ]) { try { db.exec(sql); } catch {} }
  db.exec('CREATE INDEX IF NOT EXISTS jobs_idem ON jobs(idem_key)');
  const v = db.prepare("SELECT v FROM meta WHERE k='schema'").get();
  if (!v) db.prepare("INSERT INTO meta(k,v) VALUES('schema','1')").run();
  return db;
}
const get = () => { if (!db) throw new Error('db not open'); return db; };
// run fn inside one transaction (nested calls join the outer one)
let depth = 0;
function tx(fn) {
  const d = get();
  if (depth) return fn();
  d.exec('BEGIN IMMEDIATE');
  depth++;
  try { const r = fn(); depth--; d.exec('COMMIT'); return r; }
  catch (e) { depth--; try { d.exec('ROLLBACK'); } catch {} throw e; }
}
const stmts = new Map();
const q = (sql) => { let s = stmts.get(sql); if (!s) { s = get().prepare(sql); stmts.set(sql, s); } return s; };
const all = (sql, ...a) => q(sql).all(...a);
const one = (sql, ...a) => q(sql).get(...a);
const run = (sql, ...a) => q(sql).run(...a);
// online backup to another file (consistent snapshot)
async function backup(dest) {
  const { backup: bk } = require('node:sqlite');
  if (typeof bk === 'function') return bk(get(), dest);
  get().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}
function checkpoint() { try { get().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} }
function close() { if (db) { try { checkpoint(); db.close(); } catch {} db = null; stmts.clear(); } }
module.exports = { open, get, tx, all, one, run, backup, checkpoint, close };
