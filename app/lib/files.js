'use strict';
// Server file browser (read-only) for the bot and the web panel.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const META = require('./meta');

const ROOTS = [
  { key: 'media', path: '/data/media', label: '🎬 آرشیو (فیلم و سریال)' },
  { key: 'imports', path: '/data/usb-imports', label: '📤 منتقل‌شده از حافظه‌ها' },
  { key: 'torrents', path: '/data/torrents', label: '📥 دانلودهای تورنت' },
];
const rootOf = (key) => ROOTS.find((r) => r.key === key) || null;
function resolve(key, rel) {
  const r = rootOf(key); if (!r) throw Object.assign(new Error('ریشه‌ی نامعتبر'), { user: true });
  const p = path.resolve(r.path, rel || '.');
  if (p !== r.path && !p.startsWith(r.path + '/')) throw Object.assign(new Error('مسیر نامعتبر'), { user: true });
  return p;
}
async function list(key, rel) {
  const dir = resolve(key, rel);
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const de of ents) {
    if (de.name === '.staging' || de.name.startsWith('.')) continue;
    let size = 0, mtime = 0, isDir = de.isDirectory();
    try { const st = await fsp.stat(path.join(dir, de.name)); size = st.size; mtime = st.mtimeMs; isDir = st.isDirectory(); } catch {}
    out.push({ name: de.name, dir: isDir, size, mtime });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}
async function inspect(key, rel) { return META.inspect(resolve(key, rel)); }
function df(p = '/data') { const s = fs.statfsSync(p); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; }
module.exports = { ROOTS, rootOf, resolve, list, inspect, df };
