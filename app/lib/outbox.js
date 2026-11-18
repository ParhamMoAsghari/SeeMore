'use strict';
// Notification outbox (table `notifications`): durable pending -> sent | failed queue. Producers insert
// a row (in the same transaction as the state change that caused it, when possible); a worker renders
// and sends it, retrying with backoff, so notices survive bot/network downtime and restarts.
// Rows carry a `dedupe` key so a notice is never queued twice for the same event.
const DB = require('./db');
const U = require('./util');
const { EventEmitter } = require('events');

const renderers = {};       // kind -> async (payload, row) => { text, markup, onSent? } | null (drop)
let sender = null;          // async (uid, text, markup) -> message
let timer = null, busy = false;
const ev = new EventEmitter();
const MAX = 12;

function enqueue(uid, kind, payload = {}, dedupe = null) {
  try {
    DB.run('INSERT INTO notifications(t,uid,kind,payload,dedupe,status,next_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dedupe) DO NOTHING',
      Date.now(), Number(uid), kind, JSON.stringify(payload), dedupe, 'pending', Date.now());
  } catch (e) { U.log('warn', 'outbox enqueue: ' + e.message); }
  setImmediate(tick);
}
const register = (kind, fn) => { renderers[kind] = fn; };
// plain text notice (payload: {text, markup})
renderers.text = async (p) => ({ text: p.text, markup: p.markup || undefined });
async function tick() {
  if (busy || !sender) return;
  busy = true;
  try {
    const rows = DB.all("SELECT * FROM notifications WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 10", Date.now());
    for (const r of rows) {
      const fn = renderers[r.kind];
      if (!fn) { if (Date.now() - r.t > 600000) DB.run("UPDATE notifications SET status='failed', err='no renderer' WHERE id=?", r.id); continue; }
      try {
        const m = await fn(JSON.parse(r.payload || '{}'), r);
        if (!m) { DB.run("UPDATE notifications SET status='sent', sent_at=?, err='dropped' WHERE id=?", Date.now(), r.id); continue; }
        const msg = await sender(r.uid, m.text, m.markup);
        DB.run("UPDATE notifications SET status='sent', sent_at=?, msg_id=?, err=NULL WHERE id=?", Date.now(), msg && msg.message_id || null, r.id);
        if (m.onSent) { try { await m.onSent(msg); } catch {} }
        ev.emit('sent', r);
      } catch (e) {
        const n = r.attempts + 1;
        const permanent = e.code === 403 || e.code === 400 && /chat not found|blocked/i.test(e.message || '');
        const st = permanent || n >= MAX ? 'failed' : 'pending';
        DB.run('UPDATE notifications SET attempts=?, status=?, next_at=?, err=? WHERE id=?', n, st, Date.now() + Math.min(1800000, 5000 * 2 ** n), String(e.message || e).slice(0, 200), r.id);
        if (e.net) break; // network down: stop this round
      }
    }
  } catch (e) { U.log('warn', 'outbox: ' + e.message); } finally { busy = false; }
}
function start(send) {
  sender = send;
  if (!timer) timer = setInterval(tick, 3000);
  setImmediate(tick);
  // keep 30 days of history
  DB.run("DELETE FROM notifications WHERE status!='pending' AND t < ?", Date.now() - 30 * 86400000);
}
const stats = () => Object.fromEntries(DB.all('SELECT status, COUNT(*) n FROM notifications GROUP BY status').map((r) => [r.status, r.n]));
module.exports = { enqueue, register, start, tick, stats, ev };
