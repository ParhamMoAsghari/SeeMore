'use strict';
// Crash-test controller: talks to the same DB as tests/reference/worker.js (WAL allows a second process).
// usage: node tests/reference/ctl.js <cmd> [json]
//   tousb {drive, srcDir, dest}   queue a to_usb job of every file under srcDir (absolute, allowed root)
//   move {drive, rel, toDrive, dest}  queue a usb_move job (cross-drive)
//   import {drive, rel}           scan + import (default selection)
//   core {method, params}         call a core service method as the owner
//   job {id} | jobs | events {after, job} | outbox | health
const fs = require('fs');
const path = require('path');
const DB = require('../../lib/db');
const P = require('../../lib/perms');
DB.open(process.env.DB_FILE || '/smt/bot.db');
P.setOwner(Number(process.env.BALE_CHAT_ID || process.env.CHAT_ID || 1001));
const J = require('../../lib/jobs');
const S = require('../../lib/usb');
const core = require('../../lib/core');
const [cmd, arg] = [process.argv[2], JSON.parse(process.argv[3] || '{}')];
const out = (x) => { console.log(JSON.stringify(x, null, 1)); };
const drv = (name) => { const x = S.readDrives().find((d) => d.name === name || d.label === name); if (!x) throw new Error('no drive ' + name); return x; };
function walk(d, base = d, acc = []) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p, base, acc); else acc.push({ src: p, rel: path.relative(base, p), size: st.size }); } return acc; }
(async () => {
  const owner = P.owner();
  if (cmd === 'tousb') {
    const x = drv(arg.drive); await S.ensureMarker(x); x.marker = S.readMarker(x.mount);
    const files = walk(arg.srcDir).map((f) => ({ src: f.src, dst: path.posix.join(arg.dest || '', f.rel), size: f.size, role: 'video' }));
    out(J.create({ kind: 'to_usb', uid: owner, title: 'smtest to_usb', src: { type: 'fs' }, dst: S.endpoint(x), files }));
  } else if (cmd === 'move') {
    const a = drv(arg.drive), b = drv(arg.toDrive);
    for (const x of [a, b]) { await S.ensureMarker(x); x.marker = S.readMarker(x.mount); }
    const base = S.safeJoin(a.mount, arg.rel);
    const files = walk(base).map((f) => ({ src: path.posix.join(arg.rel, f.rel), dst: path.posix.join(arg.dest || '', path.basename(arg.rel), f.rel), size: f.size }));
    out(J.create({ kind: 'usb_move', uid: owner, title: 'smtest move', src: S.endpoint(a), dst: S.endpoint(b), files, data: { srcRoot: arg.rel } }));
  } else if (cmd === 'import') {
    const x = drv(arg.drive); await S.ensureMarker(x).catch(() => {});
    const sc = await core.call(owner, 'import.scan', { drive: x.id, rel: arg.rel || '' });
    const brief = { movies: sc.movies.map((m) => ({ title: m.title, year: m.year, match: m.match && m.match.title, dup: !!m.dup, conf: m.conf, why: m.why })), series: sc.series.map((s) => ({ title: s.title, match: s.match && s.match.title, eps: s.eps.map((e) => `${e.s}x${e.e}${e.dup ? ' dup' : ''}`) })), other: sc.other.length, skipped: (sc.skipped || []).map((k) => `${k.rel} (${k.why})`), unknown: sc.unknown.length, stages: sc.stages };
    if (arg.dry) return out(brief);
    const sel = arg.sel || null;
    const job = await core.call(owner, 'import.start', { scanId: sc.scanId, sel: sel || undefined });
    out({ scan: brief, job: { id: job.id, files: J.files(job.id).length } });
  } else if (cmd === 'core') out(await core.call(owner, arg.method, arg.params || {}));
  else if (cmd === 'job') out({ ...J.get(arg.id), files: J.files(arg.id).map((f) => `${f.idx} ${f.status}${f.verified ? ' v' : ''} ${f.dst}`) });
  else if (cmd === 'jobs') out(J.list({ limit: 20 }).map((j) => `${j.id} ${j.kind} ${j.status}/${j.state} ph=${j.phase} att=${j.attempts} err=${j.err || ''} rec=${j.recovery ? JSON.stringify(j.recovery) : ''}`));
  else if (cmd === 'events') out(J.eventsSince(arg.after || 0, 500, arg.job).map((e) => `${e.seq} ${e.job_id} ${e.type} ${e.state}`));
  else if (cmd === 'outbox') out({ stats: require('../../lib/outbox').stats(), rows: DB.all('SELECT id, uid, kind, dedupe, status, attempts, err FROM notifications ORDER BY id') });
  else if (cmd === 'health') out(J.recoveryStatus());
  else throw new Error('unknown cmd');
  process.exit(0); // exit before any setImmediate kick (link/job runners belong to the worker process)
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
