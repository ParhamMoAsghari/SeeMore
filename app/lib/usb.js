'use strict';
// USB drives: host-mounted drives (state written by /usr/local/sbin/usb-automount), library scan,
// drive browsing and a persistent background copy queue. No dependencies.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const U = require('./util');

const CTL = process.env.USB_CTL || '/usbctl';
const USB_ROOT = process.env.USB_ROOT || '/media/usb';
const MEDIA = process.env.MEDIA_ROOT || '/data/media';
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm|mpg|mpeg|flv)$/i;
const SUBS = /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i;
const FAT_MAX = 4294967295; // 4 GiB - 1
const FS_NAME = { vfat: 'FAT32', exfat: 'exFAT', ntfs: 'NTFS', ext4: 'ext4', ext3: 'ext3', ext2: 'ext2', btrfs: 'Btrfs', xfs: 'XFS' };

// ---------- drives ----------
function readDrives() {
  let names = [];
  try { names = fs.readdirSync(path.join(CTL, 'drives')).filter((n) => /^[a-f0-9]{8}\.json$/.test(n)); } catch { return []; }
  const rootDev = (() => { try { return fs.statSync(USB_ROOT).dev; } catch { return null; } })();
  const out = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CTL, 'drives', n), 'utf8'));
      const ign = (() => { try { return require('./settings').get('usb.ignore_label_regex'); } catch { return ''; } })();
      if (ign) { try { if (new RegExp(ign).test(j.label || j.name || '')) continue; } catch { /* bad regex: ignore setting */ } }
      const st = fs.statSync(j.mount);
      if (rootDev != null && st.dev === rootDev && !process.env.USB_NODEVCHECK) continue; // not (yet) visible as a mount inside the container
      const sf = fs.statfsSync(j.mount);
      j.total = sf.blocks * sf.bsize; j.free = sf.bavail * sf.bsize; j.used = j.total - sf.bfree * sf.bsize;
      j.fsName = FS_NAME[j.fstype] || j.fstype;
      j.title = j.label || [j.vendor, j.model].filter(Boolean).join(' ') || j.name;
      j.marker = readMarker(j.mount);
      out.push(j);
    } catch {}
  }
  return out.sort((a, b) => a.mountedAt - b.mountedAt);
}
const getDrive = (id) => readDrives().find((x) => x.id === id) || null;

// ---------- device identity ----------
// A drive is identified by a composite of: seemore marker (.seemore/id, random, written when the drive
// is writable), filesystem UUID, partition PARTUUID, partition size, and the device serial / model /
// vendor reported by udev (ID_SERIAL etc., recorded by the host automount script). Jobs store this
// identity and only resume on a STRONG match, never on a different drive that merely reuses a name or
// a cloned/duplicate UUID.
const MARK_DIR = '.seemore', MARK_FILE = 'id';
function readMarker(mount) { try { const v = fs.readFileSync(path.join(mount, MARK_DIR, MARK_FILE), 'utf8').trim(); return /^[a-f0-9]{32}$/.test(v) ? v : null; } catch { return null; } }
async function ensureMarker(drive) {
  if (!drive || drive.ro) return drive && drive.marker || null;
  const cur = readMarker(drive.mount); if (cur) return cur;
  try {
    const dir = path.join(drive.mount, MARK_DIR); await fsp.mkdir(dir, { recursive: true });
    const id = require('crypto').randomBytes(16).toString('hex');
    const tmp = path.join(dir, MARK_FILE + '.tmp');
    const fh = await fsp.open(tmp, 'w'); await fh.writeFile(id + '\n'); await fh.sync(); await fh.close();
    await fsp.rename(tmp, path.join(dir, MARK_FILE)); await fsyncDir(dir); await fsyncDir(drive.mount);
    drive.marker = id; return id;
  } catch (e) { U.log('warn', `marker on ${drive.name}: ${e.code || e.message}`); return null; }
}
const identOf = (x) => ({ marker: x.marker || null, uuid: x.uuid || null, partuuid: x.partuuid || null, serial: x.serial || null, model: x.model || null, vendor: x.vendor || null, size: Number(x.size) || null, fstype: x.fstype || null, label: x.label || null });
// job endpoint for a drive (identity snapshot + display name)
const endpoint = (x) => ({ type: 'usb', uuid: x.uuid || null, id: x.id, name: x.name, ident: identOf(x) });
// strong match: returns {ok, why}
function identMatch(a, x) {
  if (!a) return { ok: false, why: 'no identity' };
  const b = identOf(x);
  const both = (k) => a[k] != null && b[k] != null;
  for (const k of ['marker', 'uuid', 'partuuid', 'serial', 'size', 'fstype']) if (both(k) && String(a[k]) !== String(b[k])) return { ok: false, why: `${k} differs` };
  if (both('marker')) return { ok: true, why: 'marker' };
  if (a.marker && !b.marker && !x.ro) return { ok: false, why: 'marker missing (different or reformatted drive)' };
  // no marker on one side (read-only drive or legacy job): need at least two independent strong fields
  const strong = ['uuid', 'partuuid', 'serial'].filter(both).length + (both('size') ? 1 : 0);
  return strong >= 2 ? { ok: true, why: 'composite' } : { ok: false, why: 'not enough identity data' };
}
function findByIdent(ep) {
  if (!ep || ep.type !== 'usb') return null;
  const ds = readDrives();
  if (ep.ident) return ds.find((x) => identMatch(ep.ident, x).ok) || null;
  // legacy endpoint (before identities): uuid + id must both match
  return ds.find((x) => ep.uuid && x.uuid === ep.uuid && x.id === ep.id) || null;
}

async function eject(id) {
  const req = path.join(CTL, 'requests', `${id}.eject`);
  const res = path.join(CTL, 'results', `${id}.json`);
  const t0 = Math.floor(Date.now() / 1000) - 1;
  await fsp.writeFile(req, JSON.stringify({ id, t: Date.now() }));
  for (let i = 0; i < 60; i++) {
    await U.sleep(500);
    try {
      const r = JSON.parse(await fsp.readFile(res, 'utf8'));
      if (r.t >= t0) return r;
    } catch {}
  }
  return { ok: false, msg: 'timeout' };
}

// ---------- library (filesystem, so subtitles next to files are included) ----------
let libCache = { t: 0, m: [], s: [] };
async function lsSafe(dir) { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } }
async function sizeOf(p) { try { return (await fsp.stat(p)).size; } catch { return 0; } }
async function subsFor(dir, file, names) {
  const base = file.replace(/\.[^.]+$/, '');
  const out = [];
  for (const n of names) if (n !== file && SUBS.test(n) && (n.startsWith(base + '.') || n === base)) out.push({ src: path.join(dir, n), name: n, size: await sizeOf(path.join(dir, n)) });
  return out;
}
async function scanMovies() {
  const out = [];
  for (const de of await lsSafe(path.join(MEDIA, 'movies'))) {
    if (!de.isDirectory()) continue;
    const dir = path.join(MEDIA, 'movies', de.name);
    const names = (await lsSafe(dir)).filter((x) => x.isFile()).map((x) => x.name);
    const vids = names.filter((n) => VIDEO.test(n) && !/sample/i.test(n));
    if (!vids.length) continue;
    const files = [];
    for (const v of vids) files.push({ src: path.join(dir, v), name: v, size: await sizeOf(path.join(dir, v)), subs: await subsFor(dir, v, names) });
    out.push({ name: de.name, files, size: files.reduce((a, f) => a + f.size, 0) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function scanSeries() {
  const out = [];
  for (const de of await lsSafe(path.join(MEDIA, 'tv'))) {
    if (!de.isDirectory()) continue;
    const sdir = path.join(MEDIA, 'tv', de.name);
    const eps = [];
    const walk = async (dir, rel, depth) => {
      const ents = await lsSafe(dir);
      const names = ents.filter((x) => x.isFile()).map((x) => x.name);
      for (const n of names) {
        if (!VIDEO.test(n) || /sample/i.test(n)) continue;
        const m = n.match(/S(\d{1,2})[ ._-]?E(\d{1,3})/i) || n.match(/(\d{1,2})x(\d{2,3})/);
        const fm = rel.match(/(?:season|فصل)\s*(\d+)/i);
        const s = m ? Number(m[1]) : fm ? Number(fm[1]) : 0;
        const e = m ? Number(m[2]) : 0;
        eps.push({ s, e, name: n, rel, src: path.join(dir, n), size: await sizeOf(path.join(dir, n)), subs: await subsFor(dir, n, names) });
      }
      if (depth < 2) for (const x of ents) if (x.isDirectory()) await walk(path.join(dir, x.name), rel ? `${rel}/${x.name}` : x.name, depth + 1);
    };
    await walk(sdir, '', 0);
    if (!eps.length) continue;
    eps.sort((a, b) => a.s - b.s || a.e - b.e || a.name.localeCompare(b.name));
    out.push({ name: de.name, eps, size: eps.reduce((a, f) => a + f.size, 0), seasons: [...new Set(eps.map((x) => x.s))] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function library(force) {
  if (!force && Date.now() - libCache.t < 60000) return libCache;
  const [m, s] = await Promise.all([scanMovies(), scanSeries()]);
  libCache = { t: Date.now(), m, s };
  return libCache;
}

// ---------- browse ----------
const hidden = (n) => n.startsWith('.') || /^(System Volume Information|\$RECYCLE\.BIN|lost\+found)$/i.test(n);
function safeJoin(root, rel) {
  const p = path.resolve(root, rel || '.');
  if (p !== root && !p.startsWith(root + '/')) throw new Error('مسیر نامعتبر');
  return p;
}
async function listDir(drive, rel) {
  const dir = safeJoin(drive.mount, rel);
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const de of ents) {
    if (hidden(de.name)) continue;
    let size = 0, mtime = 0, isDir = de.isDirectory();
    try { const st = await fsp.stat(path.join(dir, de.name)); size = st.size; mtime = st.mtimeMs; isDir = st.isDirectory(); } catch {}
    out.push({ name: de.name, dir: isDir, size, mtime });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}
async function dirSize(p) {
  let n = 0;
  for (const de of await lsSafe(p)) { const q = path.join(p, de.name); if (de.isDirectory()) n += await dirSize(q); else n += await sizeOf(q); }
  return n;
}
async function removePath(drive, rel) {
  if (!rel) throw new Error('ریشه‌ی فلش را نمی‌شود حذف کرد');
  const p = safeJoin(drive.mount, rel);
  await fsp.rm(p, { recursive: true, force: false });
  try { const fd = await fsp.open(path.dirname(p), 'r'); await fd.sync().catch(() => {}); await fd.close(); } catch {}
}

// ---------- copy planning ----------
const FAT_LIKE = new Set(['vfat', 'exfat', 'ntfs']);
function cleanName(n, fstype) {
  if (!FAT_LIKE.has(fstype)) return n;
  return n.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '_';
}
// items: [{src, size, dst (relative, '/'-separated)}]
async function plan(drive, items, folder) {
  const files = [];
  for (const it of items) {
    const rel = [folder, ...it.dst.split('/')].filter(Boolean).map((x) => cleanName(x, drive.fstype)).join('/');
    const f = { src: it.src, dst: rel, size: it.size, sub: !!it.sub };
    if (drive.fstype === 'vfat' && it.size > FAT_MAX) f.skip = 'fat';
    else {
      try { const st = await fsp.stat(path.join(drive.mount, rel)); if (st.size === it.size) f.skip = 'exists'; } catch {}
    }
    files.push(f);
  }
  const need = files.filter((f) => !f.skip).reduce((a, f) => a + f.size, 0);
  const fresh = getDrive(drive.id) || drive;
  return { files, need, free: fresh.free, total: fresh.total, enough: need + 8 * 1048576 <= fresh.free, fat: files.filter((f) => f.skip === 'fat'), exists: files.filter((f) => f.skip === 'exists') };
}

// ---------- file management on a drive (instant, same filesystem) ----------
const BAD_NAME = /[\/\x00]/;
function checkName(name, fstype) {
  name = String(name || '').trim();
  if (!name || name === '.' || name === '..' || BAD_NAME.test(name) || name.length > 200) throw Object.assign(new Error('اسم نامعتبر است'), { user: true });
  if (FAT_LIKE.has(fstype) && /[<>:"\\|?*]/.test(name)) throw Object.assign(new Error('این اسم روی فرمت این حافظه مجاز نیست (کاراکترهای < > : " \\ | ? * ممنوع‌اند)'), { user: true });
  return name;
}
async function fsyncDir(dir) { try { const fd = await fsp.open(dir, 'r'); await fd.sync().catch(() => {}); await fd.close(); } catch {} }
async function exists(p) { try { await fsp.lstat(p); return true; } catch { return false; } }
// "name (2).ext" style alternative that does not exist yet
async function freeName(dir, name) {
  const ext = path.extname(name), base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i++) { const n = `${base} (${i})${ext}`; if (!(await exists(path.join(dir, n)))) return n; }
  throw new Error('no free name');
}
async function mkdirOn(drive, rel, name) {
  name = checkName(name, drive.fstype);
  const dir = safeJoin(drive.mount, rel);
  const p = path.join(dir, name);
  if (await exists(p)) throw Object.assign(new Error('پوشه یا فایلی با این اسم از قبل هست'), { user: true });
  await fsp.mkdir(p); await fsyncDir(dir);
  return rel ? `${rel}/${name}` : name;
}
async function renameOn(drive, rel, name) {
  if (!rel) throw Object.assign(new Error('ریشه را نمی‌شود تغییر نام داد'), { user: true });
  name = checkName(name, drive.fstype);
  const p = safeJoin(drive.mount, rel);
  const q = path.join(path.dirname(p), name);
  if (q === p) return rel;
  if (await exists(q) && q.toLowerCase() !== p.toLowerCase()) throw Object.assign(new Error('پوشه یا فایلی با این اسم از قبل هست'), { user: true });
  await fsp.rename(p, q); await fsyncDir(path.dirname(p));
  const up = path.posix.dirname(rel);
  return up === '.' ? name : `${up}/${name}`;
}
// same drive move: one rename (atomic). mode: 'ask' | 'overwrite' | 'keep'
async function moveOn(drive, rel, destRel, mode = 'ask') {
  const p = safeJoin(drive.mount, rel);
  const dir = safeJoin(drive.mount, destRel);
  if (dir === p || dir.startsWith(p + '/')) throw Object.assign(new Error('نمی‌شود یک پوشه را به داخل خودش منتقل کرد'), { user: true });
  let name = path.basename(p);
  let q = path.join(dir, name);
  if (path.dirname(p) === dir) throw Object.assign(new Error('مبدأ و مقصد یکی است'), { user: true });
  if (await exists(q)) {
    if (mode === 'ask') return { conflict: name };
    if (mode === 'keep') { name = await freeName(dir, name); q = path.join(dir, name); }
    else {
      const st = await fsp.lstat(q);
      if (st.isDirectory()) await fsp.rm(q, { recursive: true }); else await fsp.unlink(q);
    }
  }
  await fsp.rename(p, q);
  await fsyncDir(path.dirname(p)); await fsyncDir(dir);
  return { ok: true, rel: destRel ? `${destRel}/${name}` : name };
}
// list every file under a path (relative to the drive root) for copy/move jobs
async function walkFiles(root, rel, out = [], limit = 20000) {
  const p = safeJoin(root, rel);
  const st = await fsp.stat(p);
  if (!st.isDirectory()) { out.push({ rel, size: st.size }); return out; }
  for (const de of await fsp.readdir(p, { withFileTypes: true })) {
    if (out.length >= limit) break;
    const r = rel ? `${rel}/${de.name}` : de.name;
    if (de.isDirectory()) await walkFiles(root, r, out, limit);
    else if (de.isFile()) { try { out.push({ rel: r, size: (await fsp.stat(path.join(p, de.name))).size }); } catch {} }
  }
  return out;
}

Object.assign(module.exports, { readDrives, getDrive, readMarker, ensureMarker, identOf, endpoint, identMatch, findByIdent, eject, library, listDir, dirSize, removePath, plan, safeJoin, cleanName, checkName, freeName, exists, mkdirOn, renameOn, moveOn, walkFiles, fsyncDir, hidden, VIDEO, SUBS, FAT_MAX, USB_ROOT, MEDIA, FS_NAME });
