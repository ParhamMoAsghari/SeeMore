'use strict';
// GET /api/v1/events — Server-Sent Events.
//  * durable job events (table job_events) carry `id: <seq>`; a reconnect with Last-Event-ID (or ?after=)
//    replays everything missed, so the panel never shows a stale job state after a network drop/restart.
//  * live, non-durable events have no id (they do not move the client's Last-Event-ID):
//      progress  (every ~4 s per running job: bytes done, speed, current file)
//      drives    (external drive list changed: attach / detach / free space)
//      settings  (a runtime setting changed)
// Users only see events of their own jobs; the owner sees all.
const J = require('../jobs');
const P = require('../perms');
const S = require('../usb');
const SET = require('../settings');

const clients = new Set();
function stream(req, res, uid) {
  const u = new URL(req.url, 'http://x');
  let after = Number(req.headers['last-event-id'] || u.searchParams.get('after') || 0) || 0;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const own = (jobId) => { if (P.isOwner(uid)) return true; const j = J.get(jobId); return !!j && j.uid === uid; };
  const c = {
    uid, res,
    durable(e) { if (e.seq <= after) return; after = e.seq; if (!own(e.job_id)) return; res.write(`id: ${e.seq}\nevent: job\ndata: ${JSON.stringify({ seq: e.seq, job: e.job_id, t: e.t, type: e.type, state: e.state, data: e.data })}\n\n`); },
    live(type, data, jobId) { if (jobId && !own(jobId)) return; res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); },
  };
  // replay (paged)
  for (;;) { const rows = J.eventsSince(after, 1000); for (const e of rows) c.durable(e); if (rows.length < 1000) break; }
  res.write(`event: hello\ndata: ${JSON.stringify({ lastSeq: after, t: Date.now() })}\n\n`);
  clients.add(c);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(ka); clients.delete(c); });
}
const broadcast = (fn) => { for (const c of clients) { try { fn(c); } catch {} } };

let started = false; let lastDrives = '';
function start() {
  if (started) return; started = true;
  J.ev.on('event', (e) => broadcast((c) => c.durable(e)));
  J.ev.on('progress', (j) => { if (!j) return; const d = { job: j.id, state: j.state, done: j.done || 0, total: (j.data && j.data.total) || 0, speed: Math.round(j.speed || 0), cur: j.cur || null, idx: j.idx || 0, n: j.n || 0 }; broadcast((c) => c.live('progress', d, j.id)); });
  SET.ev.on('change', (k, v) => broadcast((c) => { if (P.isOwner(c.uid)) c.live('settings', { key: k, value: k.startsWith('bot.token') ? undefined : v }); }));
  setInterval(() => {
    if (!clients.size) return;
    let ds; try { ds = S.readDrives().map((x) => ({ id: x.id, name: x.name, free: Math.round((x.free || 0) / 1048576), ro: !!x.ro })); } catch { return; }
    const sig = JSON.stringify(ds);
    if (sig !== lastDrives) { lastDrives = sig; broadcast((c) => { if (P.can(c.uid, 'usb_view')) c.live('drives', { drives: ds }); }); }
  }, 3000).unref();
}
module.exports = { stream, start, clients };
