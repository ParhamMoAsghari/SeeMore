'use strict';
// seemore core process. Starts the core (durable job engine, outbox, watchers, download-link server :3001,
// webhook receiver/RPC :3000) and its interfaces: the seemore API + React panel (:3002, lib/api) and the
// messenger bot (Telegram by default, Bale optional; lib/messenger.js). State lives in SQLite (/state/bot.db, WAL, synchronous=FULL).
const fs = require('fs');
const path = require('path');
const U = require('./lib/util');
const C = require('./lib/config');
const DB = require('./lib/db');
const P = require('./lib/perms');

if (!C.CHAT) { console.error('ALLOWED_CHAT (owner id) missing'); process.exit(1); }
DB.open(process.env.DB_FILE || '/state/bot.db');
P.setOwner(C.CHAT);
require('./lib/settings').start();
// bot token: read from the env variable named by setting bot.token_env (the token itself never leaves env)
C.TOKEN = process.env[require('./lib/settings').get('bot.token_env')] || C.TOKEN;
if (!C.TOKEN) { console.error('bot token missing (env ' + require('./lib/settings').get('bot.token_env') + ')'); process.exit(1); }
const Store = require('./lib/store');
const { createMessenger } = require('./lib/messenger');
const J = require('./lib/jobs');
const I = require('./lib/importer');
const L = require('./lib/links');
const createHandlers = require('./lib/handlers');
const createNotify = require('./lib/notify');
const { asUser } = require('./lib/fan');
const OB = require('./lib/outbox');
const V = require('./lib/views');

const store = new Store(C.STATE_FILE, C.CHAT);
const bale = createMessenger(require('./lib/settings').get('bot.messenger'), C.TOKEN, C.CHAT, store);
const h = createHandlers(bale, store);
const notify = createNotify(bale, store, h);

let lastPollOk = Date.now();
const started = Date.now();
notify.setHealth(() => Date.now() - lastPollOk < 150000 || Date.now() - started < 120000);

// one entry point for updates from long polling and from the webhook receiver; update_id below the stored
// offset was already handled (Telegram re-delivers webhook updates after a non-2xx or a restart)
// the update offset is kept per messenger (update ids of Telegram and Bale are unrelated)
const OFF = bale.kind === 'bale' ? 'offset' : `offset_${bale.kind}`;
function dispatch(ups) {
  let n = 0;
  for (const u of ups) {
    if (typeof u.update_id !== 'number' || (store.d[OFF] && u.update_id < store.d[OFF])) continue;
    store.d[OFF] = u.update_id + 1; n++;
    h.onUpdate(u).catch((e) => U.log('error', 'update crashed: ' + e.message)); // isolated, concurrent
  }
  if (n) store.save();
}

async function poll() {
  let backoff = 1000;
  for (;;) {
    try {
      const ups = await bale.getUpdates(store.d[OFF] || 0);
      lastPollOk = Date.now(); backoff = 1000;
      dispatch(ups);
    } catch (e) {
      U.log('warn', 'poll error: ' + e.message);
      await U.sleep(backoff); backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function setup() {
  const me = await bale.getMe();
  if (me.username) process.env.SEEMORE_BOT_USER = me.username;
  if (me.username && store.d.botUser !== me.username) { store.d.botUser = me.username; store.save(); }
  U.log('info', `bot ready as @${me.username}`);
  for (let i = 0; i < 6; i++) {
    try { await bale.setCommands(h.COMMANDS.map(([command, description]) => ({ command, description }))); break; }
    catch (e) { await U.sleep(5000 * (i + 1)); }
  }
}

// expired grants -> notify owner and the user (once)
function sweepGrants() {
  try {
    for (const u of P.sweep()) {
      U.log('info', `grant expired: ${u.uid}`);
      OB.enqueue(C.CHAT, 'text', { text: `⌛ دسترسی ${u.name || u.username || u.uid} (${u.uid}) تمام شد و خودکار قطع شد.`, markup: { inline_keyboard: [[{ text: '⏳ تمدید', callback_data: `acX:${u.uid}` }]] } }, `grant_expired:${u.uid}:${u.expires}`);
      OB.enqueue(u.uid, 'text', { text: '⌛ مدت دسترسی شما به این ربات تمام شد.' }, `grant_expired_user:${u.uid}:${u.expires}`);
    }
  } catch (e) { U.log('warn', 'grant sweep: ' + e.message); }
}

// daily backup of the bot DB + configs to /data/backups/seemore (14 days kept)
const SET = require('./lib/settings');
async function backup(force) {
  const BK = SET.get('backup.dir');
  try {
    fs.mkdirSync(BK, { recursive: true });
    const day = U.ymd(Date.now());
    const dst = path.join(BK, `bot-${day}.db`);
    if (!force && fs.existsSync(dst)) return null;
    await DB.backup(dst + '.tmp');
    const fd = fs.openSync(dst + '.tmp', 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(dst + '.tmp', dst);
    for (const f of ['/state/state.json.migrated']) { try { if (fs.existsSync(f) && !fs.existsSync(path.join(BK, 'state.json.migrated'))) fs.copyFileSync(f, path.join(BK, 'state.json.migrated')); } catch {} }
    const all = fs.readdirSync(BK).filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - SET.get('backup.keep_days')))) fs.unlinkSync(path.join(BK, f));
    U.log('info', `db backup ${dst}`);
    return dst;
  } catch (e) { U.log('warn', 'backup failed: ' + e.message); return null; }
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--selftest' || mode === '--demo' || mode === '--announce' || mode === '--backup') return require('./tools')(mode, process.argv.slice(3), { bale, store, h, notify, V, backup });
  process.on('unhandledRejection', (e) => U.log('error', 'unhandled: ' + U.redact((e && e.message) || e)));
  process.on('uncaughtException', (e) => U.log('error', 'uncaught: ' + U.redact(e.message)));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { h.usb.shutdown(); } catch {} try { store.flush(); DB.checkpoint(); DB.close(); } catch {} process.exit(0); });
  notify.startServer();
  notify.startWatcher();
  h.usb.startWatcher();
  await I.cleanStaging().catch((e) => U.log('warn', 'staging cleanup: ' + e.message));
  const b = J.boot();
  if (b.resumed.length || b.waiting.length) h.jobsui.bootNotice(b);
  L.startServer();
  try { require('./lib/config/apply').reconcile(); } catch (e) { U.log('warn', 'ctl reconcile: ' + e.message); }
  require('./lib/api/server').start();
  OB.start((uid, text, markup) => asUser(uid, () => bale.send(text, markup)));
  // schedules read their interval from settings on every tick (hot: no restart needed)
  const every = (fn, key, unitMs) => { const loop = () => { try { fn(); } catch (e) { U.log('warn', `${key}: ${e.message}`); } setTimeout(loop, Math.max(5000, SET.get(key) * unitMs)).unref(); }; return loop; };
  sweepGrants(); setTimeout(every(sweepGrants, 'schedule.grant_sweep_s', 1000), SET.get('schedule.grant_sweep_s') * 1000);
  setTimeout(every(() => backup(false), 'schedule.backup_check_min', 60000), 120000);
  setTimeout(every(() => { store.flush(); DB.checkpoint(); }, 'schedule.checkpoint_min', 60000), SET.get('schedule.checkpoint_min') * 60000);
  setup().catch((e) => U.log('error', 'setup failed: ' + e.message));
  startUpdates().catch((e) => { U.log('error', 'webhook mode failed, falling back to polling: ' + e.message); poll(); });
}

// bot.update_mode: polling (default) or webhook (adapters with startWebhook, i.e. Telegram)
async function startUpdates() {
  const mode = SET.get('bot.update_mode');
  if (mode !== 'webhook' || !bale.startWebhook) {
    if (mode === 'webhook') U.log('warn', `webhook mode is not supported by the ${bale.kind} adapter; using polling`);
    if (bale.deleteWebhook) await bale.deleteWebhook().catch((e) => U.log('warn', 'deleteWebhook: ' + e.message)); // getUpdates is refused while a webhook is set
    return poll();
  }
  const url = SET.get('bot.webhook_url');
  if (!url) throw new Error('bot.webhook_url is empty');
  const secret = process.env.BOT_WEBHOOK_SECRET || require('crypto').createHash('sha256').update('seemore-webhook:' + C.TOKEN).digest('hex').slice(0, 48);
  const pathname = new URL(url).pathname || '/';
  await bale.startWebhook({ port: SET.get('bot.webhook_port'), path: pathname, secret, onUpdate: (u) => { lastPollOk = Date.now(); dispatch([u]); } });
  await bale.setWebhook(url, secret);
  U.log('info', `webhook mode: receiving updates on :${SET.get('bot.webhook_port')}${pathname}`);
  // health: a webhook bot gets no traffic when idle, so check the webhook state instead
  const check = async () => { try { const i = await bale.getWebhookInfo(); if (i && i.url === url) lastPollOk = Date.now(); if (i && i.last_error_message) U.log('warn', 'webhook: ' + i.last_error_message); } catch (e) { U.log('warn', 'getWebhookInfo: ' + e.message); } };
  check(); setInterval(check, 60000).unref();
}
main();
