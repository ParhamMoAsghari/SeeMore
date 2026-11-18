'use strict';
// UI state (pagination, wizards, caches, dedupe) kept in memory and persisted to SQLite (table kv,
// one row per top-level key, changed rows written in one transaction). Per-chat UI state (last menu
// message, pending text prompt, wizards) is routed to d.sess[<chat>] through accessors, so every
// granted user has an independent session. Durable domain data (jobs, permissions, links) lives in
// its own tables (see db.js), not here.
const fs = require('fs');
const DB = require('./db');
const ctx = require('./ctx');
const { log } = require('./util');

const DEFAULTS = () => ({
  offset: 0, searches: {}, objs: {}, flows: {}, rels: {}, photoMsgs: [], posterFiles: {},
  notified: {}, watch: {}, commandsSet: 0, sess: {}, usbKnown: {},
});
const SESSION_KEYS = ['last', 'await', 'libctx', 'usbw', 'usbBrowse', 'usbMove', 'impw', 'fsb', 'lkw', 'acw', 'mlw'];

class Store {
  constructor(file, owner) {
    this.file = file;              // legacy state.json (migrated once)
    this.owner = owner;
    this.d = DEFAULTS();
    this.written = new Map();
    this.timer = null;
    const rows = DB.all('SELECT k, v FROM kv');
    if (rows.length) {
      for (const r of rows) { try { this.d[r.k] = JSON.parse(r.v); this.written.set(r.k, r.v); } catch {} }
    } else if (file && fs.existsSync(file)) {
      try {
        const old = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
        const sess = {};
        const s0 = (sess[owner] = {});
        for (const k of Object.keys(old)) {
          if (k === 'usbJobs') continue; // old finished copy jobs; kept only in the backup
          if (SESSION_KEYS.includes(k)) s0[k] = old[k]; else this.d[k] = old[k];
        }
        this.d.sess = sess;
        this.flush();
        fs.renameSync(file, `${file}.migrated`);
        log('info', 'state.json migrated to SQLite');
      } catch (e) { log('warn', 'state migration failed: ' + e.message); }
    }
    this.d.sess = this.d.sess || {};
    const self = this;
    for (const k of SESSION_KEYS) {
      Object.defineProperty(this.d, k, {
        enumerable: false, configurable: true,
        get() { const s = self.sess(); if (k === 'last' && !s.last) s.last = {}; return s[k] ?? null; },
        set(v) { self.sess()[k] = v; },
      });
    }
  }
  sess(chat) {
    const c = String(chat || ctx.chat() || this.owner);
    return (this.d.sess[c] = this.d.sess[c] || { last: {} });
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
  }
  prune() {
    const d = this.d;
    const trimObj = (o, n, key = 't') => {
      const ks = Object.keys(o || {});
      if (ks.length <= n) return;
      ks.sort((a, b) => (o[a][key] || 0) - (o[b][key] || 0)).slice(0, ks.length - n).forEach((k) => delete o[k]);
    };
    trimObj(d.searches, 15); trimObj(d.flows, 30); trimObj(d.rels, 15);
    const oks = Object.keys(d.objs);
    if (oks.length > 250) oks.slice(0, oks.length - 250).forEach((k) => delete d.objs[k]);
    const pk = Object.keys(d.posterFiles);
    if (pk.length > 400) pk.slice(0, pk.length - 400).forEach((k) => delete d.posterFiles[k]);
    if (d.photoMsgs.length > 300) d.photoMsgs = d.photoMsgs.slice(-300);
    const cutoff = Date.now() - 3 * 86400000;
    for (const k of Object.keys(d.notified)) if (d.notified[k] < cutoff) delete d.notified[k];
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      this.prune();
      const now = Date.now();
      const changed = [];
      for (const k of Object.keys(this.d)) {
        const v = JSON.stringify(this.d[k]);
        if (v === undefined) continue;
        if (this.written.get(k) !== v) changed.push([k, v]);
      }
      if (!changed.length) return;
      DB.tx(() => { for (const [k, v] of changed) DB.run('INSERT INTO kv(k,v,t) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t', k, v, now); });
      for (const [k, v] of changed) this.written.set(k, v);
    } catch (e) { log('error', 'state save failed: ' + e.message); }
  }
}
Store.SESSION_KEYS = SESSION_KEYS;
module.exports = Store;
