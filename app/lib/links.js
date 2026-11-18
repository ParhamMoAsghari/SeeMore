'use strict';
// Download links (service + HTTP endpoint /dl/<token>).
//  ZIP: streamed on the fly in store mode (no compression), zip64 when needed, exact Content-Length,
//       Range/resume support. CRC-32 values are computed while streaming and cached in SQLite
//       (crc_cache), a background worker pre-computes them so resumed downloads stay cheap.
//  RAR: built asynchronously (RARLAB rar, -m0) into /data/dl-cache/<token>/ from hard links that keep
//       the Series/Season folders; rebuilt from scratch after a crash; deleted when the link expires.
//  file: a single file with Range.
// Tokens are 128-bit random, stored with item list (paths validated under /data/media), expiry,
// max downloads, creator and a revoked flag. Per-IP rate limits; every request is logged (link_hits).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const DB = require('./db');
const U = require('./util');

const MEDIA = process.env.MEDIA_ROOT || '/data/media';
const CACHE = process.env.DL_CACHE || '/data/dl-cache';
const SET = require('./settings');
// base URLs are read live from settings (DB > env DL_PUBLIC/DL_LAN > default)
const pub = () => String(SET.get('links.public_base')).replace(/\/$/, '');
const lan = () => String(SET.get('links.lan_base')).replace(/\/$/, '');
const PORT = Number(process.env.DL_PORT || 3001);
const ev = new EventEmitter();
const M32 = 0xffffffff;

// ---------- model ----------
const parse = (r) => (r ? { ...r, items: JSON.parse(r.items) } : null);
const get = (token) => parse(DB.one('SELECT * FROM links WHERE token=?', String(token)));
const list = ({ uid = null, all = false, limit = 30 } = {}) => DB.all(`SELECT * FROM links WHERE 1=1 ${uid != null ? 'AND creator=?' : ''} ${all ? '' : 'AND revoked=0'} ORDER BY created DESC LIMIT ?`, ...(uid != null ? [uid] : []), limit).map(parse);
const urls = (token) => ({ public: `${pub()}/dl/${token}`, lan: `${lan()}/dl/${token}`, page: `${pub()}/dl/${token}/`, pageLan: `${lan()}/dl/${token}/` });
function state(l) {
  if (!l) return 'missing';
  if (l.revoked) return 'revoked';
  if (l.expires && l.expires < Date.now()) return 'expired';
  if (l.max_dl && l.downloads >= l.max_dl) return 'used';
  return 'active';
}
async function safeMedia(p) {
  const real = await fsp.realpath(p);
  if (!(real === MEDIA || real.startsWith(MEDIA + '/'))) throw new Error('path outside /data/media');
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new Error('not a file');
  return { real, st };
}
// files: [{path, arc}] (arc = path inside the archive, '/'-separated)
async function create({ uid, kind = 'zip', title, files, expires = null, maxDl = null }) {
  if (!files.length) throw new Error('هیچ فایلی انتخاب نشده');
  if (kind === 'file' && files.length !== 1) kind = 'zip';
  const items = [];
  const seen = new Set();
  for (const f of files) {
    const { real, st } = await safeMedia(f.path);
    let arc = String(f.arc || path.basename(real)).replace(/^\/+/, '').replace(/\.\.+\//g, '');
    if (seen.has(arc)) continue; seen.add(arc);
    items.push({ path: real, arc, size: st.size });
  }
  const token = crypto.randomBytes(16).toString('base64url');
  const total = items.reduce((a, x) => a + x.size, 0);
  DB.run('INSERT INTO links(token,kind,title,items,total,expires,max_dl,creator,created,rar_status) VALUES(?,?,?,?,?,?,?,?,?,?)',
    token, kind, String(title || 'download').slice(0, 120), JSON.stringify(items), total, expires, maxDl, uid ?? null, Date.now(), kind === 'rar' ? 'queued' : null);
  if (kind === 'rar') setImmediate(rarKick); else setImmediate(crcKick);
  return get(token);
}
function revoke(token, by) { DB.run('UPDATE links SET revoked=1 WHERE token=?', token); U.log('info', `link revoked by ${by}`); setImmediate(sweep); }
function extend(token, expires) { DB.run('UPDATE links SET expires=? WHERE token=?', expires, token); }
const hits = (token, limit = 10) => DB.all('SELECT * FROM link_hits WHERE token=? ORDER BY id DESC LIMIT ?', token, limit);

// ---------- CRC cache ----------
function crcCached(p, st) { const r = DB.one('SELECT crc FROM crc_cache WHERE path=? AND size=? AND mtime=?', p, st.size, Math.floor(st.mtimeMs)); return r ? r.crc >>> 0 : null; }
function crcStore(p, st, crc) { DB.run('INSERT INTO crc_cache(path,size,mtime,crc) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, crc=excluded.crc', p, st.size, Math.floor(st.mtimeMs), crc >>> 0); }
async function crcRange(p, start, end, init = 0) { // [start, end)
  let c = init;
  if (end <= start) return c;
  for await (const ch of fs.createReadStream(p, { start, end: end - 1, highWaterMark: 1 << 20 })) c = zlib.crc32(ch, c);
  return c >>> 0;
}
const crcBusy = new Set();
async function crcFull(p, st) {
  const c = crcCached(p, st); if (c != null) return c;
  const v = await crcRange(p, 0, st.size);
  crcStore(p, st, v);
  return v;
}
let crcRunning = false;
async function crcKick() {
  if (crcRunning) return; crcRunning = true;
  try {
    for (const l of DB.all("SELECT * FROM links WHERE revoked=0 AND kind='zip' AND (expires IS NULL OR expires>?)", Date.now()).map(parse)) {
      for (const it of l.items) {
        if (crcBusy.has(it.path)) continue;
        const st = await fsp.stat(it.path).catch(() => null);
        if (!st || crcCached(it.path, st) != null) continue;
        crcBusy.add(it.path);
        try { await crcFull(it.path, st); } catch {} finally { crcBusy.delete(it.path); }
        await U.sleep(200);
      }
    }
  } finally { crcRunning = false; }
}

// ---------- ZIP layout ----------
function dosTime(ms) {
  const d = new Date(ms);
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function layout(items) {
  const ents = [];
  let off = 0;
  for (const it of items) {
    const st = await fsp.stat(it.path);
    const name = Buffer.from(it.arc, 'utf8');
    const z64 = st.size >= M32;
    const lh = Buffer.alloc(30 + name.length + (z64 ? 20 : 0));
    const dt = dosTime(st.mtimeMs);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(z64 ? 45 : 20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dt.time, 10); lh.writeUInt16LE(dt.date, 12); lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(z64 ? M32 : 0, 18); lh.writeUInt32LE(z64 ? M32 : 0, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(z64 ? 20 : 0, 28); name.copy(lh, 30);
    if (z64) { const e = 30 + name.length; lh.writeUInt16LE(0x0001, e); lh.writeUInt16LE(16, e + 2); lh.writeBigUInt64LE(0n, e + 4); lh.writeBigUInt64LE(0n, e + 12); }
    const ddLen = z64 ? 24 : 16;
    ents.push({ ...it, st, size: st.size, name, z64, dt, lh, off, dataOff: off + lh.length, ddOff: off + lh.length + st.size, ddLen });
    off += lh.length + st.size + ddLen;
  }
  const cdOff = off;
  let cdLen = 0;
  for (const e of ents) {
    const k = (e.size >= M32 ? 2 : 0) + (e.off >= M32 ? 1 : 0);
    e.cdExtra = k ? 4 + 8 * k : 0;
    cdLen += 46 + e.name.length + e.cdExtra;
  }
  const need64 = ents.length > 0xfffe || cdOff >= M32 || cdLen >= M32;
  const endLen = (need64 ? 56 + 20 : 0) + 22;
  return { ents, cdOff, cdLen, endLen, need64, total: cdOff + cdLen + endLen };
}
function ddBuf(e, crc) {
  const b = Buffer.alloc(e.ddLen);
  b.writeUInt32LE(0x08074b50, 0); b.writeUInt32LE(crc >>> 0, 4);
  if (e.z64) { b.writeBigUInt64LE(BigInt(e.size), 8); b.writeBigUInt64LE(BigInt(e.size), 16); } else { b.writeUInt32LE(e.size, 8); b.writeUInt32LE(e.size, 12); }
  return b;
}
function tailBuf(L, crcs) {
  const parts = [];
  for (const [i, e] of L.ents.entries()) {
    const h = Buffer.alloc(46 + e.name.length + e.cdExtra);
    const big = e.size >= M32, bigOff = e.off >= M32;
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE((3 << 8) | 45, 4); h.writeUInt16LE(big || bigOff ? 45 : 20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(e.dt.time, 12); h.writeUInt16LE(e.dt.date, 14); h.writeUInt32LE(crcs[i] >>> 0, 16);
    h.writeUInt32LE(big ? M32 : e.size, 20); h.writeUInt32LE(big ? M32 : e.size, 24);
    h.writeUInt16LE(e.name.length, 28); h.writeUInt16LE(e.cdExtra, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38); h.writeUInt32LE(bigOff ? M32 : e.off, 42); e.name.copy(h, 46);
    if (e.cdExtra) {
      let p = 46 + e.name.length; h.writeUInt16LE(0x0001, p); h.writeUInt16LE(e.cdExtra - 4, p + 2); p += 4;
      if (big) { h.writeBigUInt64LE(BigInt(e.size), p); p += 8; h.writeBigUInt64LE(BigInt(e.size), p); p += 8; }
      if (bigOff) { h.writeBigUInt64LE(BigInt(e.off), p); p += 8; }
    }
    parts.push(h);
  }
  const n = L.ents.length;
  if (L.need64) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14); r.writeUInt32LE(0, 16); r.writeUInt32LE(0, 20);
    r.writeBigUInt64LE(BigInt(n), 24); r.writeBigUInt64LE(BigInt(n), 32); r.writeBigUInt64LE(BigInt(L.cdLen), 40); r.writeBigUInt64LE(BigInt(L.cdOff), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(L.cdOff + L.cdLen), 8); loc.writeUInt32LE(1, 16);
    parts.push(r, loc);
  }
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(0, 4); eo.writeUInt16LE(0, 6);
  eo.writeUInt16LE(Math.min(n, 0xffff), 8); eo.writeUInt16LE(Math.min(n, 0xffff), 10);
  eo.writeUInt32LE(L.cdLen >= M32 ? M32 : L.cdLen, 12); eo.writeUInt32LE(L.cdOff >= M32 ? M32 : L.cdOff, 16); eo.writeUInt16LE(0, 20);
  parts.push(eo);
  return Buffer.concat(parts);
}
// stream bytes [a, b] (inclusive) of the zip into res
async function streamZip(L, a, b, res, isClosed) {
  const crcs = L.ents.map((e) => crcCached(e.path, e.st));
  const write = (buf) => new Promise((ok) => { if (res.write(buf)) ok(); else res.once('drain', ok); });
  const slice = async (buf, segStart) => {
    const s = Math.max(a, segStart), t = Math.min(b + 1, segStart + buf.length);
    if (s < t) await write(buf.subarray(s - segStart, t - segStart));
  };
  for (const [i, e] of L.ents.entries()) {
    if (isClosed()) return;
    if (e.ddOff + e.ddLen <= a) continue;
    if (e.off > b) break;
    await slice(e.lh, e.off);
    // data
    const ds = Math.max(a, e.dataOff), de = Math.min(b + 1, e.dataOff + e.size);
    let crc = crcs[i];
    if (ds < de) {
      const rel0 = ds - e.dataOff, rel1 = de - e.dataOff;
      let c = crc == null && rel0 > 0 ? await crcRange(e.path, 0, rel0) : 0;
      const track = crc == null;
      const rs = fs.createReadStream(e.path, { start: rel0, end: rel1 - 1, highWaterMark: 1 << 20 });
      try {
        for await (const ch of rs) {
          if (isClosed()) { rs.destroy(); return; }
          if (track) c = zlib.crc32(ch, c);
          await write(ch);
        }
      } finally { rs.destroy(); }
      if (track && rel1 === e.size) { crc = c >>> 0; crcs[i] = crc; crcStore(e.path, e.st, crc); }
    }
    if (e.ddOff <= b && e.ddOff + e.ddLen > a) {
      if (crc == null) { crc = await crcFull(e.path, e.st); crcs[i] = crc; }
      await slice(ddBuf(e, crc), e.ddOff);
    }
  }
  if (b >= L.cdOff && !isClosed()) {
    for (let i = 0; i < crcs.length; i++) if (crcs[i] == null) crcs[i] = await crcFull(L.ents[i].path, L.ents[i].st);
    await slice(tailBuf(L, crcs), L.cdOff);
  }
}

// ---------- RAR builder ----------
let rarRunning = null;
const rarPaths = (token) => { const dir = path.join(CACHE, token); return { dir, tree: path.join(dir, 'tree'), part: path.join(dir, 'building.rar'), out: path.join(dir, 'archive.rar') }; };
async function rarKick() {
  if (rarRunning) return;
  const r = DB.one("SELECT * FROM links WHERE kind='rar' AND rar_status='queued' AND revoked=0 ORDER BY created LIMIT 1");
  if (!r) return;
  const l = parse(r);
  rarRunning = l.token;
  const P = rarPaths(l.token);
  try {
    DB.run("UPDATE links SET rar_status='building', rar_err=NULL WHERE token=?", l.token);
    await fsp.rm(P.tree, { recursive: true, force: true }); await fsp.rm(P.part, { force: true });
    await fsp.mkdir(P.tree, { recursive: true });
    const free = fs.statfsSync(CACHE); if (free.bavail * free.bsize < l.total + SET.get('links.rar_min_free_mb') * 1048576) throw new Error('nospace');
    for (const it of l.items) {
      const dst = path.join(P.tree, it.arc);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      try { await fsp.link(it.path, dst); } catch { await fsp.copyFile(it.path, dst); }
    }
    const tops = [...new Set(l.items.map((it) => it.arc.split('/')[0]))];
    await new Promise((ok, bad) => {
      const p = spawn('rar', ['a', '-m0', '-ma5', '-r', '-idq', '-y', '-o+', P.part, '--', ...tops], { cwd: P.tree, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('error', bad);
      p.on('close', (code) => (code === 0 ? ok() : bad(new Error(`rar exit ${code}: ${err.slice(0, 120)}`))));
    });
    const fd = await fsp.open(P.part, 'r'); await fd.sync(); await fd.close();
    await fsp.rename(P.part, P.out);
    await fsp.rm(P.tree, { recursive: true, force: true });
    const st = await fsp.stat(P.out);
    DB.run("UPDATE links SET rar_status='ready', rar_size=? WHERE token=?", st.size, l.token);
    ev.emit('rarReady', get(l.token));
  } catch (e) {
    U.log('warn', `rar build ${l.token.slice(0, 4)}: ${e.message}`);
    await fsp.rm(P.dir, { recursive: true, force: true }).catch(() => {});
    DB.run("UPDATE links SET rar_status='failed', rar_err=? WHERE token=?", U.trunc(e.message, 120), l.token);
    ev.emit('rarFailed', get(l.token));
  } finally { rarRunning = null; setImmediate(rarKick); }
}
function rarProgress(token) {
  const l = get(token); if (!l) return null;
  if (l.rar_status !== 'building') return { status: l.rar_status };
  let size = 0; try { size = fs.statSync(rarPaths(token).part).size; } catch {}
  return { status: 'building', pct: l.total ? Math.min(99, Math.floor((size / l.total) * 100)) : 0 };
}
function rebuildRar(token) { DB.run("UPDATE links SET rar_status='queued', rar_err=NULL WHERE token=? AND kind='rar'", token); setImmediate(rarKick); }

// cleanup: caches of expired / revoked links; boot: interrupted builds are rebuilt
async function sweep() {
  for (const l of DB.all("SELECT * FROM links WHERE kind='rar' AND rar_status IS NOT NULL AND rar_status!='deleted'").map(parse)) {
    const s = state(l);
    if (s === 'revoked' || s === 'expired' || s === 'used') { await fsp.rm(rarPaths(l.token).dir, { recursive: true, force: true }).catch(() => {}); DB.run("UPDATE links SET rar_status='deleted' WHERE token=?", l.token); }
  }
  // orphan cache dirs
  try { for (const n of await fsp.readdir(CACHE)) { const l = get(n); if (!l || l.rar_status === 'deleted') await fsp.rm(path.join(CACHE, n), { recursive: true, force: true }); } } catch {}
  DB.run('DELETE FROM link_hits WHERE t < ?', Date.now() - 90 * 86400000);
  DB.run('DELETE FROM crc_cache WHERE path NOT IN (SELECT DISTINCT j.value ->> \'$.path\' FROM links, json_each(links.items) AS j)');
}
function bootRar() {
  DB.run("UPDATE links SET rar_status='queued' WHERE kind='rar' AND rar_status='building'");
  fs.mkdirSync(CACHE, { recursive: true });
  setTimeout(rarKick, 3000);
  setTimeout(crcKick, 20000);
  setInterval(() => sweep().catch(() => {}), 10 * 60000);
  setTimeout(() => sweep().catch(() => {}), 30000);
}

// ---------- HTTP ----------
const rl = new Map(); // ip -> {t, n, bad, badT, conc, blockUntil}
function limiter(ip) {
  let s = rl.get(ip); const now = Date.now();
  if (!s) { s = { t: now, n: 0, bad: 0, badT: now, conc: 0, block: 0 }; rl.set(ip, s); }
  if (now - s.t > 60000) { s.t = now; s.n = 0; }
  if (now - s.badT > 600000) { s.badT = now; s.bad = 0; }
  if (rl.size > 5000) for (const [k, v] of rl) if (now - v.t > 600000 && !v.conc) rl.delete(k);
  return s;
}
const MIME = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.srt': 'application/x-subrip', '.ass': 'text/x-ssa', '.mov': 'video/quicktime', '.ts': 'video/mp2t' };
const enc = (n) => `attachment; filename="${n.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
const safeName = (t) => String(t || 'download').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'download';
function parseRange(h, total) {
  if (!h) return null;
  const m = String(h).match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let a, b;
  if (m[1] === '') { const n = Number(m[2]); a = Math.max(0, total - n); b = total - 1; }
  else { a = Number(m[1]); b = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (a > b || a >= total) return 'bad';
  return [a, b];
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function page(res, code, title, body) {
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Vazirmatn,Tahoma,sans-serif;background:#0f172a;color:#e2e8f0;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.9}a{color:#38bdf8}
.btn{display:inline-block;background:#0284c7;color:#fff;padding:.6rem 1.2rem;border-radius:.6rem;text-decoration:none;margin:.5rem 0}li{margin:.2rem 0}.m{color:#94a3b8;font-size:.9rem}</style></head><body>${body}</body></html>`;
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}
const faNum = (n) => Number(n).toLocaleString('fa-IR');

async function handle(req, res) {
  // the port is only reachable from the docker network (Caddy); Caddy replaces any client-sent X-Forwarded-For,
  // and we take the right-most entry (the one added by the proxy) so a spoofed header cannot dodge the limits
  const ip = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '?';
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/dl\/([A-Za-z0-9_-]{16,40})(\/(?:f\/(\d+))?)?$/);
  const t0 = Date.now();
  let status = 200, bytes = 0, token = m ? m[1] : null;
  const s = limiter(ip);
  const log = () => {
    try { if (token) DB.run('INSERT INTO link_hits(token,t,ip,range,status,bytes,ua) VALUES(?,?,?,?,?,?,?)', token, t0, ip, req.headers.range || null, status, bytes, String(req.headers['user-agent'] || '').slice(0, 120)); } catch {}
    U.log('info', 'dl', { ip, path: token ? `/dl/${token.slice(0, 4)}…${m && m[2] ? m[2] : ''}` : url.pathname.slice(0, 40), status, bytes, ms: Date.now() - t0 });
  };
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (s.block > Date.now()) { status = 429; res.writeHead(429, { 'Retry-After': '600' }); res.end('Too many requests'); return log(); }
  if (++s.n > SET.get('links.rate_per_min')) { status = 429; res.writeHead(429, { 'Retry-After': '60' }); res.end('Too many requests'); return log(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { status = 405; res.writeHead(405); res.end(); return log(); }
  const l = m ? get(token) : null;
  const st = state(l);
  if (!m || st === 'missing') {
    if (++s.bad > SET.get('links.bad_token_block')) s.block = Date.now() + 600000;
    status = 404; page(res, 404, 'یافت نشد', '<h2>لینک پیدا نشد</h2>'); return log();
  }
  if (st !== 'active' && !(st === 'used' && req.headers.range && !/^bytes=0-/.test(req.headers.range))) {
    status = 410; page(res, 410, 'لینک نامعتبر', `<h2>${{ revoked: 'این لینک لغو شده است', expired: 'مهلت این لینک تمام شده است', used: 'سقف دفعات دانلود این لینک پر شده است' }[st]}</h2>`); return log();
  }
  if (s.conc >= SET.get('links.max_parallel')) { status = 429; res.writeHead(429, { 'Retry-After': '30' }); res.end('Too many parallel downloads'); return log(); }
  s.conc++;
  let closed = false;
  res.on('close', () => { closed = true; });
  try {
    // landing page
    if (m[2] === '/') {
      const exp = l.expires ? `${U.jalali(l.expires)} ساعت ${U.hhmm(l.expires)}` : 'بدون انقضا';
      let main = `<a class="btn" href="/dl/${token}">⬇️ دانلود ${l.kind === 'rar' ? 'RAR' : l.kind === 'zip' ? 'ZIP' : 'فایل'} (${U.bytes(l.total)})</a>`;
      if (l.kind === 'rar' && l.rar_status !== 'ready') main = `<p>فایل RAR در حال آماده‌سازی است (${l.rar_status === 'building' ? `${faNum((rarProgress(token) || {}).pct || 0)}٪` : l.rar_status === 'failed' ? 'خطا' : 'در صف'}). کمی بعد دوباره سر بزنید.</p>`;
      const lis = l.items.map((it, i) => `<li><a href="/dl/${token}/f/${i}">${esc(it.arc)}</a> <span class="m">${U.bytes(it.size)}</span></li>`).join('');
      page(res, 200, l.title, `<h2>${esc(l.title)}</h2><p class="m">${faNum(l.items.length)} فایل · ${U.bytes(l.total)} · اعتبار: ${exp}${l.max_dl ? ` · ${faNum(l.downloads)} از ${faNum(l.max_dl)} دانلود` : ''}</p>${main}<h3>فایل‌ها (دانلود تکی با امکان ادامه)</h3><ol>${lis}</ol>`);
      return;
    }
    let kind = l.kind, file = null;
    if (m[3] != null) { const it = l.items[Number(m[3])]; if (!it) { status = 404; page(res, 404, 'یافت نشد', '<h2>فایل پیدا نشد</h2>'); return; } kind = 'file'; file = it; }
    else if (kind === 'file') file = l.items[0];
    const range = req.headers.range;
    const counts = !range || /^bytes=0-/.test(range);
    if (kind === 'file' || kind === 'rar') {
      let p, name, total;
      if (kind === 'rar') {
        if (l.rar_status !== 'ready') { status = 503; res.writeHead(503, { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' }); res.end('RAR is being prepared, try again later'); return; }
        p = rarPaths(token).out; name = `${safeName(l.title)}.rar`;
      } else { p = (await safeMedia(file.path)).real; name = path.basename(file.arc); }
      const fst = await fsp.stat(p); total = fst.size;
      const etag = `"${token.slice(0, 8)}-${total}-${Math.floor(fst.mtimeMs)}"`;
      let r = parseRange(range, total);
      if (r && req.headers['if-range'] && req.headers['if-range'] !== etag) r = null;
      if (r === 'bad') { status = 416; res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return; }
      const [a, b] = r || [0, total - 1];
      status = r ? 206 : 200;
      res.writeHead(status, { 'Content-Type': kind === 'rar' ? 'application/vnd.rar' : MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes', ETag: etag,
        'Content-Disposition': enc(name), 'Cache-Control': 'private, no-store', ...(r ? { 'Content-Range': `bytes ${a}-${b}/${total}` } : {}) });
      if (counts) DB.run('UPDATE links SET downloads=downloads+1, last_dl=? WHERE token=?', Date.now(), token);
      if (req.method === 'HEAD' || total === 0) { res.end(); return; }
      const rs = fs.createReadStream(p, { start: a, end: b, highWaterMark: 1 << 20 });
      rs.on('data', (c) => { bytes += c.length; });
      await new Promise((ok) => { rs.pipe(res); rs.on('error', () => { res.destroy(); ok(); }); res.on('close', () => { rs.destroy(); ok(); }); res.on('finish', ok); });
      return;
    }
    // zip
    for (const it of l.items) await safeMedia(it.path);
    const L = await layout(l.items);
    const etag = `"${token.slice(0, 8)}-${L.total}"`;
    let r = parseRange(range, L.total);
    if (r && req.headers['if-range'] && req.headers['if-range'] !== etag) r = null;
    if (r === 'bad') { status = 416; res.writeHead(416, { 'Content-Range': `bytes */${L.total}` }); res.end(); return; }
    const [a, b] = r || [0, L.total - 1];
    status = r ? 206 : 200;
    res.writeHead(status, { 'Content-Type': 'application/zip', 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes', ETag: etag, 'Content-Disposition': enc(`${safeName(l.title)}.zip`), 'Cache-Control': 'private, no-store', ...(r ? { 'Content-Range': `bytes ${a}-${b}/${L.total}` } : {}) });
    if (counts) DB.run('UPDATE links SET downloads=downloads+1, last_dl=? WHERE token=?', Date.now(), token);
    if (req.method === 'HEAD') { res.end(); return; }
    const w0 = res.write.bind(res);
    res.write = (c, ...x) => { bytes += c.length; return w0(c, ...x); };
    await streamZip(L, a, b, res, () => closed);
    if (!closed) res.end();
  } catch (e) {
    status = 500; U.log('warn', 'dl error: ' + e.message);
    if (!res.headersSent) page(res, 500, 'خطا', '<h2>خطا در آماده‌سازی فایل</h2>'); else res.destroy();
  } finally { s.conc--; log(); }
}
function startServer() {
  const srv = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch {} }); });
  srv.requestTimeout = 0; srv.headersTimeout = 30000; srv.keepAliveTimeout = 15000;
  srv.listen(PORT, () => U.log('info', `download server on :${PORT}`));
  bootRar();
  // pick up links queued by other processes (RPC/API, tools)
  setInterval(() => { rarKick().catch(() => {}); }, 15000);
  setInterval(() => { crcKick().catch(() => {}); }, 60000);
  return srv;
}

module.exports = { create, get, list, revoke, extend, state, urls, hits, rarProgress, rebuildRar, startServer, layout, streamZip, ev, sweep, CACHE, get PUBLIC() { return pub(); }, get LAN() { return lan(); } };
