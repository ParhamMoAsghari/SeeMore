'use strict';
// Crash-test worker: the real job engine, importer, outbox and link server, with a recording
// messenger stand-in (no Bale traffic). Run in a throwaway container with its own DB:
//   DB_FILE=/smt/bot.db SM_TEST_HOOKS=1 SM_TEST_DIR=/smt node tests/reference/worker.js
// Sends are appended to $SM_TEST_DIR/sent.jsonl; if $SM_TEST_DIR/sender-down exists every send fails
// (simulates Bale being unreachable), so notifications stay pending in the outbox.
const fs = require('fs');
const path = require('path');
const DIR = process.env.SM_TEST_DIR || '/smt';
const DB = require('../../lib/db');
const P = require('../../lib/perms');
DB.open(process.env.DB_FILE || path.join(DIR, 'bot.db'));
P.setOwner(Number(process.env.BALE_CHAT_ID || process.env.CHAT_ID || 1001));
require('../../lib/settings').start();
const J = require('../../lib/jobs');
require('../../lib/importer');
const L = require('../../lib/links');
const OB = require('../../lib/outbox');
for (const k of ['job_end', 'job_waiting', 'job_resumed', 'rar_ready']) OB.register(k, async (p) => {
  const j = p.job ? J.get(p.job) : null;
  if (k === 'job_end' && j && !['done', 'failed', 'canceled'].includes(j.status)) return null;
  if (k === 'job_waiting' && j && j.status !== 'waiting') return null;
  return { text: `${k} ${p.job || p.token} ${j ? j.status : ''}` };
});
OB.register('boot', async (p) => ({ text: p.text }));
let n = 0;
OB.start(async (uid, text) => {
  if (fs.existsSync(path.join(DIR, 'sender-down'))) throw Object.assign(new Error('network down (test)'), { code: 'ECONNRESET' });
  fs.appendFileSync(path.join(DIR, 'sent.jsonl'), JSON.stringify({ t: Date.now(), uid, text }) + '\n');
  return { message_id: ++n };
});
const b = J.boot();
OB.enqueue(P.owner(), 'boot', { text: `boot resumed=${b.resumed.length} waiting=${b.waiting.length}` }, `boot:${Date.now()}`);
L.startServer();
console.log(`WORKER up pid=${process.pid} resumed=${b.resumed.map((j) => j.id)} waiting=${b.waiting.map((j) => j.id)}`);
J.ev.on('event', (e) => console.log(`EV ${e.seq} ${e.job_id} ${e.type} ${e.state}`));
process.on('SIGTERM', () => { try { DB.checkpoint(); DB.close(); } catch {} process.exit(0); });
