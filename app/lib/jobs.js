'use strict';
// Durable, resumable file-transfer job engine (SQLite manifest; one job runs at a time).
//
// Lifecycle (exposed as job.state, see state()):
//   queued -> running -> verifying -> committing -> completed
//   plus waiting_for_device (drive gone / read-only / I/O error; auto-resumes on a strong identity
//   match of the SAME drive), paused (interrupted, resumable by the user), failed, canceled.
// Stored columns: status (engine status: queued|running|waiting|done|failed|canceled), phase
// (copy|verify|commit), attempts, idem_key, recovery (JSON: what boot/reconcile found and did).
// Every transition and periodic progress is appended to job_events (monotonic seq, replayable for
// SSE clients via Last-Event-ID); user-facing notices go through the notifications outbox.
// Idempotency: each job has idem_key = hash(kind, user, endpoints, files) (re-submitting the same job
// while it is active returns the existing one) and each file row has its own idem_key; recovery checks
// the real destination (exists + size + sample hash) before copying anything again, and the import post
// phase checks Radarr/Sonarr records before importing again.
// Kinds: to_usb (library -> drive), import (drive -> /data staging -> archive, post phase),
//        usb_copy / usb_move (inside a drive or between two drives).
// Endpoints: {type:'usb', uuid, name} (paths relative to the drive root; drive found by UUID) or
//            {type:'fs'} (absolute paths, must stay under ALLOWED_FS roots).
// Per file: pending -> copying -> verifying -> done (or skipped / failed). Writes go to <dst>.part,
// fsync(file), verify size + sample hash, rename, fsync(dir), then the row is marked done in its own
// transaction. On start and before every run the manifest is reconciled (stale .part removed, the last
// finished file re-verified). Drive gone / read-only / I/O error -> job 'waiting' (paused) and resumes
// by itself when the same drive (UUID) is mounted again.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const DB = require('./db');
const U = require('./util');
const S = require('./usb');
const OB = require('./outbox');
const { hook } = require('./testhooks');

const ALLOWED_FS = ['/data/media', '/data/usb-imports', '/data/torrents', '/data/dl-cache'];
const ACTIVE = ['queued', 'running', 'waiting'];
const CHUNK = 4 * 1048576;
const DRIVE_ERR = new Set(['EIO', 'EROFS', 'ENODEV', 'ENXIO', 'EBADF', 'ESTALE', 'ENOTCONN', 'EUCLEAN']);

class DriveError extends Error { constructor(code, uuid) { super(code); this.drive = code; this.uuid = uuid; } }

const ev = new EventEmitter();
ev.setMaxListeners(50);
const mem = new Map(); // id -> live fields (done bytes, speed, cur...)
let running = null;
const posts = {};
let started = false;

// ---------- persistence ----------
function rowToJob(r) {
  if (!r) return null;
  const j = { ...r, data: JSON.parse(r.data || '{}'), recovery: r.recovery ? JSON.parse(r.recovery) : null };
  Object.assign(j, mem.get(j.id) || {}, { phase: r.phase }); // persisted phase wins over the live copy
  j.state = state(j);
  return j;
}
const get = (id) => rowToJob(DB.one('SELECT * FROM jobs WHERE id=?', id));
const files = (id) => DB.all('SELECT * FROM job_files WHERE job_id=? ORDER BY idx', id);
const list = ({ active = false, limit = 20, uid = null } = {}) => DB.all(
  `SELECT * FROM jobs WHERE 1=1 ${active ? `AND status IN ('queued','running','waiting')` : ''} ${uid != null ? 'AND uid=?' : ''} ORDER BY created DESC LIMIT ?`,
  ...(uid != null ? [uid] : []), limit).map(rowToJob);
// lifecycle state from engine status + phase
const DEVICE_ERR = new Set(['gone', 'rofs', 'io']);
function state(j) {
  if (!j) return null;
  if (j.status === 'running') return j.phase === 'commit' ? 'committing' : j.phase === 'verify' ? 'verifying' : 'running';
  if (j.status === 'waiting') return DEVICE_ERR.has(j.err) ? 'waiting_for_device' : 'paused';
  if (j.status === 'done') return 'completed';
  if (j.status === 'canceled') return 'canceled';
  return j.status; // queued | failed
}
function event(jobId, type, st, data) {
  const r = DB.run('INSERT INTO job_events(job_id,t,type,state,data) VALUES(?,?,?,?,?)', jobId, Date.now(), type, st || null, data == null ? null : JSON.stringify(data));
  const row = { seq: Number(r.lastInsertRowid), job_id: jobId, t: Date.now(), type, state: st || null, data };
  setImmediate(() => ev.emit('event', row));
  return row;
}
const eventsSince = (after = 0, limit = 500, jobId = null) => DB.all(`SELECT * FROM job_events WHERE seq>? ${jobId ? 'AND job_id=?' : ''} ORDER BY seq LIMIT ?`, Number(after) || 0, ...(jobId ? [jobId] : []), limit)
  .map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
// status change + its event (+ optional outbox notice) in ONE transaction
function setStatus(id, status, extra = {}, notice = null) {
  DB.tx(() => {
    const sets = ['status=?', 'updated=?']; const vals = [status, Date.now()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(k === 'data' || k === 'recovery' ? JSON.stringify(v) : v); }
    DB.run(`UPDATE jobs SET ${sets.join(',')} WHERE id=?`, ...vals, id);
    const j = rowToJob(DB.one('SELECT * FROM jobs WHERE id=?', id));
    event(id, 'status', state(j), { status, err: j.err || null, phase: j.phase || null });
    if (notice) OB.enqueue(j.uid || require('./perms').owner(), notice, { job: id }, `${notice}:${id}:${j.attempts || 0}:${status}`);
  });
}
function setPhase(id, phase) {
  DB.tx(() => { DB.run('UPDATE jobs SET phase=?, updated=? WHERE id=?', phase, Date.now(), id); const j = rowToJob(DB.one('SELECT * FROM jobs WHERE id=?', id)); event(id, 'status', state(j), { status: j.status, phase }); });
}
const saveData = (job) => DB.run('UPDATE jobs SET data=?, updated=? WHERE id=?', JSON.stringify(job.data), Date.now(), job.id);
const setFile = (jobId, idx, fields) => {
  const ks = Object.keys(fields);
  DB.run(`UPDATE job_files SET ${ks.map((k) => `${k}=?`).join(',')} WHERE job_id=? AND idx=?`, ...ks.map((k) => fields[k]), jobId, idx);
};

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 32);
const epSig = (ep) => (ep && ep.type === 'usb' ? `usb:${(ep.ident && (ep.ident.marker || ep.ident.uuid)) || ep.uuid || ep.id}` : 'fs');
function create({ kind, uid, title, src, dst, files: fl, data = {}, idemKey = null }) {
  // snapshot the drive identity for usb endpoints that were built without one
  for (const ep of [src, dst]) if (ep && ep.type === 'usb' && !ep.ident) { const dv = S.readDrives().find((x) => x.id === ep.id); if (dv) ep.ident = S.identOf(dv); }
  const key = idemKey || sha(JSON.stringify([kind, uid ?? null, epSig(src), epSig(dst), fl.map((f) => [f.src, f.dst, f.size])]));
  const dup = DB.one("SELECT id FROM jobs WHERE idem_key=? AND status IN ('queued','running','waiting')", key);
  if (dup) return get(dup.id); // same request again while it is still active (double tap, retry)
  const id = crypto.randomBytes(6).toString('hex');
  const t = Date.now();
  const d = { ...data, src, dst };
  d.total = fl.filter((f) => !f.skip || f.skip === 'overwrite').reduce((a, f) => a + f.size, 0);
  DB.tx(() => {
    DB.run('INSERT INTO jobs(id,kind,status,uid,title,data,created,updated,idem_key,phase,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,0)', id, kind, 'queued', uid ?? null, title || '', JSON.stringify(d), t, t, key, 'copy');
    fl.forEach((f, i) => DB.run('INSERT INTO job_files(job_id,idx,src,dst,size,status,skip,role,grp,idem_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, i, f.src, f.dst, f.size, f.skip && f.skip !== 'overwrite' ? 'skipped' : 'pending', f.skip || null, f.role || null, f.grp ?? null, sha(`${key}|${i}|${f.src}|${f.dst}|${f.size}`)));
    event(id, 'created', 'queued', { kind, title: title || '', files: fl.length, total: d.total, uid: uid ?? null });
  });
  setImmediate(kick);
  return get(id);
}

// ---------- paths ----------
// the drive for an endpoint: only on a STRONG identity match (marker / composite), see usb.identMatch
function driveOf(ep) { return S.findByIdent(ep); }
function resolve(ep, p) {
  if (ep.type === 'usb') {
    const dv = driveOf(ep);
    if (!dv) throw new DriveError('gone', ep.uuid);
    return S.safeJoin(dv.mount, p);
  }
  const abs = path.resolve(p);
  if (!ALLOWED_FS.some((r) => abs === r || abs.startsWith(r + '/'))) throw new Error('path outside allowed roots');
  return abs;
}
const epKey = (ep) => (ep && ep.type === 'usb' ? `usb:${ep.uuid || ep.id}` : 'fs');

// ---------- hashing / durable io ----------
async function sampleHash(p, size) {
  const h = crypto.createHash('sha1');
  h.update(String(size));
  const fd = await fsp.open(p, 'r');
  try {
    const n = 1048576;
    const offs = size <= 3 * n ? [0] : [0, Math.floor(size / 2) - n / 2, size - n];
    const buf = Buffer.alloc(size <= 3 * n ? size : n);
    for (const o of offs) { const { bytesRead } = await fd.read(buf, 0, buf.length, o); h.update(buf.subarray(0, bytesRead)); }
  } finally { await fd.close(); }
  return h.digest('hex').slice(0, 20);
}
async function fsyncDir(dir) { try { const fd = await fsp.open(dir, 'r'); await fd.sync().catch(() => {}); await fd.close(); } catch {} }
async function mkdirp(dir) {
  // create missing parents and fsync each new entry's parent so the directory itself survives a power cut
  const missing = [];
  let d = dir;
  while (!fs.existsSync(d)) { missing.unshift(d); const up = path.dirname(d); if (up === d) break; d = up; }
  for (const m of missing) { await fsp.mkdir(m).catch((e) => { if (e.code !== 'EEXIST') throw e; }); await fsyncDir(path.dirname(m)); }
}
async function copyFile(job, f, src, dst, onBytes) {
  const tmp = dst + '.part';
  await mkdirp(path.dirname(dst));
  const live = mem.get(job.id);
  const ifd = await fsp.open(src, 'r');
  let ofd = null;
  try {
    ofd = await fsp.open(tmp, 'w');
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0, since = 0;
    for (;;) {
      if (live.cancel) throw Object.assign(new Error('canceled'), { canceled: true });
      const { bytesRead } = await ifd.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      let w = 0;
      while (w < bytesRead) { const r = await ofd.write(buf, w, bytesRead - w); w += r.bytesWritten; }
      pos += bytesRead; since += bytesRead; onBytes(bytesRead);
      await hook('copy_chunk');
      // a drive pulled mid-file: stop at once instead of writing into a lazily-unmounted filesystem
      for (const ep of [job.data.src, job.data.dst]) if (ep && ep.type === 'usb' && !driveOf(ep)) throw new DriveError('gone', ep.uuid);
      if (since >= 64 * 1048576) { await ofd.datasync(); since = 0; }
    }
    await ofd.sync();
    await ofd.close(); ofd = null;
  } catch (e) {
    if (ofd) await ofd.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  } finally { await ifd.close().catch(() => {}); }
  return tmp;
}

// ---------- reconcile ----------
async function reconcile(job) {
  const fl = files(job.id);
  for (const f of fl) {
    if (f.status !== 'copying' && f.status !== 'verifying') continue;
    try { const dst = resolve(job.data.dst, f.dst); await fsp.unlink(dst + '.part').catch(() => {}); } catch (e) { if (e instanceof DriveError) throw e; }
    setFile(job.id, f.idx, { status: 'pending' });
  }
  // re-verify the last finished file (a power cut can lose data that was reported as written)
  const last = DB.one("SELECT * FROM job_files WHERE job_id=? AND status='done' AND role IS NOT 'post' ORDER BY idx DESC LIMIT 1", job.id);
  if (last && last.hash && !job.data.movedSrc) {
    try {
      const dst = resolve(job.data.dst, last.dst);
      const st = await fsp.stat(dst).catch(() => null);
      const ok = st && st.size === last.size && (await sampleHash(dst, st.size)) === last.hash;
      if (!ok && !(job.kind === 'import' && job.data.phase === 'post')) { setFile(job.id, last.idx, { status: 'pending' }); U.log('warn', `job ${job.id}: last file failed re-verify, will copy again`); }
    } catch (e) { if (e instanceof DriveError) throw e; }
  }
}

// ---------- runner ----------
function classify(e, job) {
  if (e instanceof DriveError) return e.drive;
  const code = e && e.code;
  for (const ep of [job.data.src, job.data.dst]) if (ep && ep.type === 'usb' && !driveOf(ep)) return 'gone';
  if (code === 'EROFS') return 'rofs';
  if (DRIVE_ERR.has(code)) return 'io';
  if (code === 'ENOSPC') return 'nospace';
  return null;
}
function needDrives(job) { return [job.data.src, job.data.dst].filter((ep) => ep && ep.type === 'usb'); }

async function run(job) {
  const live = { done: 0, speed: 0, idx: 0, n: 0, cur: null, cancel: false };
  mem.set(job.id, live);
  const resumePhase = job.phase === 'commit' && posts[job.kind] ? 'commit' : 'copy';
  setStatus(job.id, 'running', { started: job.started || Date.now(), err: null, attempts: (job.attempts || 0) + 1, phase: resumePhase });
  job = get(job.id);
  let lastEv = 0;
  const samples = [[Date.now(), 0]];
  const tick = setInterval(() => {
    const t = Date.now(); samples.push([t, live.done]);
    while (samples.length > 2 && t - samples[0][0] > 15000) samples.shift();
    const [t0, b0] = samples[0];
    live.speed = t > t0 ? ((live.done - b0) * 1000) / (t - t0) : 0;
    if (t - lastEv > 30000) { lastEv = t; try { event(job.id, 'progress', state(get(job.id)), { done: live.done, total: job.data.total, idx: live.idx, n: live.n, speed: Math.round(live.speed) }); } catch {} }
    ev.emit('progress', get(job.id));
  }, 4000);
  let outcome = 'done', err = null;
  try {
    for (const ep of needDrives(job)) {
      const dv = driveOf(ep);
      if (!dv) throw new DriveError('gone', ep.uuid);
      if (dv.ro && ep === job.data.dst) throw new DriveError('rofs', ep.uuid);
    }
    await reconcile(job);
    const fl = files(job.id);
    const todo = fl.filter((f) => f.status === 'pending');
    live.done = fl.filter((f) => f.status === 'done').reduce((a, f) => a + f.size, 0);
    live.n = fl.filter((f) => f.status !== 'skipped').length;
    live.idx = fl.filter((f) => f.status === 'done' || f.status === 'failed').length;
    ev.emit('progress', get(job.id));
    const usbDst = job.data.dst && job.data.dst.type === 'usb' ? job.data.dst : null;
    for (const f of todo) {
      if (usbDst) { const dv = driveOf(usbDst); if (!dv) throw new DriveError('gone'); if (dv.ro) throw new DriveError('rofs'); }
      live.idx++; live.cur = path.basename(f.dst);
      const base = live.done;
      let src, dst;
      try {
        src = resolve(job.data.src, f.src); dst = resolve(job.data.dst, f.dst);
        const st = await fsp.stat(src);
        if (st.size !== f.size) { setFile(job.id, f.idx, { status: 'failed', err: 'source changed' }); continue; }
        let hash = f.hash;
        if (!hash) { hash = await sampleHash(src, f.size); setFile(job.id, f.idx, { hash }); }
        const ex = await fsp.stat(dst).catch(() => null);
        if (ex && ex.isFile()) {
          if (ex.size === f.size && (await sampleHash(dst, ex.size)) === hash) { setFile(job.id, f.idx, { status: 'done' }); live.done = base + f.size; continue; }
          if (f.skip !== 'overwrite') { setFile(job.id, f.idx, { status: 'skipped', skip: 'exists' }); continue; }
        }
        setFile(job.id, f.idx, { status: 'copying' });
        const tmp = await copyFile(job, f, src, dst, (n) => { live.done += n; });
        setFile(job.id, f.idx, { status: 'verifying' });
        const st2 = await fsp.stat(tmp);
        if (st2.size !== f.size || (await sampleHash(tmp, st2.size)) !== hash) { await fsp.unlink(tmp).catch(() => {}); throw Object.assign(new Error('verify failed'), { code: 'EIO' }); }
        await hook('before_rename');
        await fsp.rename(tmp, dst);
        await fsyncDir(path.dirname(dst));
        setFile(job.id, f.idx, { status: 'done', err: null });
        live.done = base + f.size;
      } catch (e) {
        if (e.canceled) throw e;
        const k = classify(e, job);
        if (k) throw Object.assign(new DriveError(k), { cause: e });
        U.log('warn', `job ${job.id} file ${f.dst}: ${e.message}`);
        setFile(job.id, f.idx, { status: 'failed', err: String(e.code || e.message).slice(0, 80) });
        live.done = base + f.size;
      }
    }
    // verifying: flush the destination, then re-check every finished file (size + sample hash) from disk.
    // On USB filesystems (FAT32/exFAT/NTFS) rename is not crash-atomic, so we do not trust the copy loop alone.
    setPhase(job.id, 'verify'); ev.emit('progress', get(job.id));
    if (usbDst) { const dv = driveOf(usbDst); if (dv) { await fsyncDir(dv.mount); if (dv.ro) throw new DriveError('rofs'); } }
    let bad = 0;
    for (const f of files(job.id).filter((x) => x.status === 'done' && x.hash && x.role !== 'post')) {
      if (live.cancel) throw Object.assign(new Error('canceled'), { canceled: true });
      live.cur = path.basename(f.dst);
      await hook('verify_file');
      let dst; try { dst = resolve(job.data.dst, f.dst); } catch (e) { if (e instanceof DriveError) throw e; continue; }
      if (job.kind === 'import' && job.data.phase === 'post') break; // staged files are being moved into the archive
      const st = await fsp.stat(dst).catch((e) => { const k = classify(e, job); if (k && e.code !== 'ENOENT') throw new DriveError(k); return null; });
      const ok = st && st.size === f.size && (await sampleHash(dst, st.size).catch((e) => { const k = classify(e, job); if (k) throw new DriveError(k); return null; })) === f.hash;
      if (ok) setFile(job.id, f.idx, { verified: Date.now() });
      else { bad++; setFile(job.id, f.idx, { status: 'pending', err: 'verify' }); U.log('warn', `job ${job.id}: ${f.dst} failed final verify`); }
    }
    if (bad) { job.data.reverify = (job.data.reverify || 0) + 1; saveData(job); if (job.data.reverify > 2) throw new Error(`${bad} files failed verification`); throw Object.assign(new Error('reverify'), { again: true }); }
    setPhase(job.id, 'commit'); ev.emit('progress', get(job.id));
    // move: remove sources only after everything is safely at the destination
    if (job.kind === 'usb_move') {
      job = get(job.id);
      for (const f of files(job.id).filter((x) => x.status === 'done')) {
        try { await fsp.unlink(resolve(job.data.src, f.src)); } catch (e) { if (e.code !== 'ENOENT') { const k = classify(e, job); if (k) throw new DriveError(k); } }
      }
      if (job.data.srcRoot) { try { await removeEmptyDirs(resolve(job.data.src, job.data.srcRoot)); } catch {} }
      job.data.movedSrc = true; saveData(job);
    }
    await hook('commit_start');
    if (posts[job.kind]) {
      live.cur = null;
      job = get(job.id); job.data.phase = 'post'; saveData(job);
      ev.emit('progress', get(job.id));
      await posts[job.kind](get(job.id), { saveData, files: () => files(job.id), setFile: (i, x) => setFile(job.id, i, x), live, emit: () => ev.emit('progress', get(job.id)) });
    }
    for (const ep of needDrives(job)) { const dv = driveOf(ep); if (dv) await fsyncDir(dv.mount); }
  } catch (e) {
    if (e.again) outcome = 'again';
    else if (e.canceled) outcome = 'canceled';
    else if (e instanceof DriveError && e.drive !== 'nospace') { outcome = 'waiting'; err = e.drive; }
    else if (e instanceof DriveError && e.drive === 'nospace') { outcome = 'failed'; err = 'nospace'; }
    else { outcome = 'failed'; err = U.trunc(U.redact(e.message), 150); U.log('error', `job ${job.id} failed: ${e.stack || e.message}`); }
  } finally {
    clearInterval(tick);
  }
  const final = get(job.id);
  if (outcome === 'again') { // some files failed the final verification: copy them again (bounded)
    setStatus(job.id, 'queued', { phase: 'copy' }); mem.delete(job.id); setImmediate(kick); return;
  }
  if (outcome === 'waiting') {
    final.data.waitMounted = Object.fromEntries(needDrives(final).map((ep) => [epKey(ep), (driveOf(ep) || {}).mountedAt || 0]));
    setStatus(job.id, 'waiting', { err, data: final.data }, 'job_waiting');
  } else {
    setStatus(job.id, outcome, { err, finished: Date.now() }, 'job_end');
  }
  live.cur = null; live.cancel = false;
  mem.delete(job.id);
  const j = get(job.id);
  j.live = { ...live };
  ev.emit(outcome === 'waiting' ? 'waiting' : 'end', j);
}
async function removeEmptyDirs(dir) {
  let st; try { st = await fsp.stat(dir); } catch { return; }
  if (!st.isDirectory()) return;
  for (const n of await fsp.readdir(dir)) await removeEmptyDirs(path.join(dir, n));
  try { await fsp.rmdir(dir); await fsyncDir(path.dirname(dir)); } catch {}
}

async function kick() {
  if (running || !started) return;
  const r = DB.one("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1");
  if (!r) return;
  running = r.id;
  try { await run(rowToJob(r)); } catch (e) { U.log('error', 'job runner crashed: ' + e.message); setStatus(r.id, 'failed', { err: 'internal', finished: Date.now() }); }
  finally { running = null; setImmediate(kick); }
}

function cancel(id) {
  const j = get(id); if (!j) return false;
  if (j.status === 'running') { const l = mem.get(id); if (l) l.cancel = true; return true; }
  if (j.status === 'queued' || j.status === 'waiting') { setStatus(id, 'canceled', { finished: Date.now() }); const x = get(id); ev.emit('end', x); return true; }
  return false;
}
function resume(id) {
  const j = get(id); if (!j || ACTIVE.includes(j.status) && j.status !== 'waiting') return null;
  if (j.status === 'done') return null;
  DB.run("UPDATE job_files SET status='pending', err=NULL WHERE job_id=? AND status='failed'", id);
  setStatus(id, 'queued', { err: null, finished: null });
  setImmediate(kick);
  return get(id);
}

// waiting jobs resume when their drive(s) are back (and were re-mounted after an I/O / read-only error)
function checkWaiting() {
  for (const r of DB.all("SELECT * FROM jobs WHERE status='waiting'")) {
    const j = rowToJob(r);
    const eps = needDrives(j);
    const ok = eps.every((ep) => {
      const dv = driveOf(ep);
      if (!dv) return false;
      if (j.err === 'rofs' || j.err === 'io') return !dv.ro && dv.mountedAt !== (j.data.waitMounted || {})[epKey(ep)];
      return !(dv.ro && ep === j.data.dst);
    });
    if (ok) { setStatus(j.id, 'queued', { err: null }, 'job_resumed'); ev.emit('resumed', get(j.id)); setImmediate(kick); }
  }
}

// paths currently read or written by active jobs (absolute, resolvable ones)
function busyPaths() {
  const out = [];
  for (const r of DB.all("SELECT * FROM jobs WHERE status IN ('queued','running')")) {
    const j = rowToJob(r);
    for (const f of files(j.id)) {
      if (f.status === 'done' && j.kind !== 'usb_move') continue;
      for (const [ep, p] of [[j.data.src, f.src], [j.data.dst, f.dst]]) { try { out.push(resolve(ep, p)); } catch {} }
    }
  }
  return out;
}
function pathBusy(abs) {
  abs = path.resolve(abs);
  return busyPaths().some((p) => p === abs || p.startsWith(abs + '/') || abs.startsWith(p + '/'));
}
function driveBusy(uuidOrId) {
  return DB.all("SELECT * FROM jobs WHERE status IN ('queued','running')").map(rowToJob)
    .some((j) => needDrives(j).some((ep) => ep.uuid === uuidOrId || ep.id === uuidOrId));
}

// boot: interrupted jobs go back to the queue (or wait for their drive)
function boot() {
  const resumed = [], waiting = [];
  for (const r of DB.all("SELECT * FROM jobs WHERE status IN ('running','queued')")) {
    const j = rowToJob(r);
    const missing = needDrives(j).some((ep) => !driveOf(ep));
    const rec = { at: Date.now(), from: state(j), phase: j.phase || null, action: missing ? 'wait_for_device' : 'requeue' };
    if (missing) { setStatus(j.id, 'waiting', { err: 'gone', recovery: rec }); waiting.push(get(j.id)); }
    else { setStatus(j.id, 'queued', { recovery: rec }); if (r.status === 'running') resumed.push(get(j.id)); }
  }
  started = true;
  setInterval(checkWaiting, 3000);
  setInterval(kick, 5000); // also picks up jobs queued by other processes (RPC/API, tools)
  setTimeout(kick, 1500);
  // prune finished jobs older than 30 days
  DB.run("DELETE FROM jobs WHERE status IN ('done','canceled','failed') AND updated < ?", Date.now() - 30 * 86400000);
  DB.run('DELETE FROM job_events WHERE job_id NOT IN (SELECT id FROM jobs)');
  return { resumed, waiting };
}

const registerPost = (kind, fn) => { posts[kind] = fn; };
const summary = (id) => {
  const fl = files(id);
  const by = (s) => fl.filter((f) => f.status === s);
  return { total: fl.length, done: by('done'), failed: by('failed'), skipped: by('skipped'), pending: by('pending') };
};
// recovery view (separate from container health): what is pending, waiting for a device or failed
function recoveryStatus() {
  const by = Object.fromEntries(DB.all('SELECT status, COUNT(*) n FROM jobs GROUP BY status').map((r) => [r.status, r.n]));
  const waiting = DB.all("SELECT * FROM jobs WHERE status='waiting'").map(rowToJob).map((j) => ({ id: j.id, title: j.title, state: j.state, err: j.err, devices: needDrives(j).map((ep) => ({ name: ep.name, present: !!driveOf(ep) })) }));
  const recovered = DB.all("SELECT * FROM jobs WHERE recovery IS NOT NULL AND updated > ? ORDER BY updated DESC LIMIT 10", Date.now() - 86400000).map(rowToJob).map((j) => ({ id: j.id, title: j.title, state: j.state, recovery: j.recovery }));
  return { counts: by, running: running, waiting, recentlyRecovered: recovered, failed24h: DB.one("SELECT COUNT(*) n FROM jobs WHERE status='failed' AND updated > ?", Date.now() - 86400000).n };
}
module.exports = { state, event, eventsSince, recoveryStatus, setPhase, ev, create, get, files, list, cancel, resume, boot, kick, registerPost, saveData, setFile, setStatus, resolve, driveOf, pathBusy, driveBusy, summary, sampleHash, fsyncDir, mkdirp, DriveError, ALLOWED_FS, isRunning: () => running };
