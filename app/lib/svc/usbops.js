'use strict';
// Domain operations on external drives that both interfaces (bot UI and the HTTP API) use, so the
// business rules (busy paths, FAT32 limits, free space, device markers, durable jobs) live in one place.
const fs = require('fs');
const path = require('path');
const S = require('../usb');
const J = require('../jobs');
const P = require('../perms');
const SEL = require('./selection');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status, user: true });
function driveById(id) {
  const x = S.readDrives().find((y) => y.id === id || (y.uuid && y.uuid === id));
  if (!x) throw err('این حافظه وصل نیست', 404);
  return x;
}
function busyCheck(x, rel) {
  if (J.pathBusy(S.safeJoin(x.mount, rel || '.'))) throw err('این مسیر در حال استفاده‌ی یک انتقال است', 409);
}

// ---------- copy library items to a drive ----------
// sel: see selection.js ; folder: destination folder on the drive ('' = root)
async function copyPlan(driveId, sel, folder = '') {
  const x = driveById(driveId);
  S.assertWritable(x);
  const { title, files } = await SEL.resolve(sel);
  if (!files.length) throw err('چیزی انتخاب نشده');
  const p = await S.plan(x, files, String(folder || '').replace(/^\/+|\/+$/g, ''));
  return { title, drive: { id: x.id, name: x.name, fstype: x.fstype }, files: p.files, need: p.need, free: p.free, total: p.total, enough: p.enough,
    fat: p.fat.length, exists: p.exists.length, videos: p.files.filter((f) => !f.sub).length, subs: p.files.filter((f) => f.sub).length };
}
async function copyStart(uid, driveId, sel, folder = '', planned = null) {
  const x = driveById(driveId);
  const p = planned || await copyPlan(driveId, sel, folder);
  if (!p.need) throw err('چیزی برای کپی نمانده (همه از قبل روی حافظه هستند یا رد شده‌اند)');
  if (!p.enough) throw err(`فضای حافظه کافی نیست: ${Math.ceil(p.need / 1048576)} MB لازم است`);
  await S.ensureMarker(x).catch(() => {}); x.marker = S.readMarker(x.mount);
  const files = p.files.map((f) => ({ src: f.src, dst: f.dst, size: f.size, skip: f.skip, role: f.sub ? 'sub' : 'video' }));
  const job = J.create({ kind: 'to_usb', uid, title: p.title, src: { type: 'fs' }, dst: S.endpoint(x), files });
  P.audit(uid, 'usb_copy', 'copy', `${p.title} -> ${x.name}`);
  return job;
}

// ---------- copy / move between (or inside) drives ----------
// mode: 'ask' (returns {conflict}) | 'keep' (keep both) | 'overwrite'
async function transfer(uid, { from, rel, to, destRel = '', op = 'copy', mode = 'ask' }) {
  const src = driveById(from); const dst = driveById(to);
  rel = String(rel || ''); destRel = String(destRel || '');
  if (!rel) throw err('مبدأ نامعتبر است');
  S.assertWritable(dst);
  if (op === 'move') S.assertWritable(src); // a move deletes from the source
  busyCheck(src, rel); busyCheck(dst, destRel);
  const same = src.id === dst.id;
  const srcAbs = S.safeJoin(src.mount, rel), dirAbs = S.safeJoin(dst.mount, destRel);
  const st = await fs.promises.stat(srcAbs);
  if (same && (dirAbs === srcAbs || dirAbs.startsWith(srcAbs + '/'))) throw err('نمی‌شود یک پوشه را به داخل خودش برد');
  if (same && path.dirname(srcAbs) === dirAbs && op === 'move') throw err('مبدأ و مقصد یکی است');
  let name = path.basename(srcAbs);
  const exists = await S.exists(path.join(dirAbs, name));
  if (exists && mode === 'ask') return { conflict: name };
  if (exists && mode === 'keep') name = await S.freeName(dirAbs, name);
  if (same && op === 'move') {
    const r = await S.moveOn(dst, rel, destRel, mode === 'keep' ? 'keep' : 'overwrite');
    P.audit(uid, 'usb_manage', 'move', `${src.name}/${rel} -> ${destRel || '/'}`);
    return { done: true, rel: r.rel };
  }
  const list = await S.walkFiles(src.mount, rel);
  const base = destRel ? `${destRel}/${name}` : name;
  const files = list.map((f) => {
    const tail = f.rel === rel ? '' : f.rel.slice(rel.length + 1);
    const dstRel = tail ? `${base}/${tail}` : base;
    const o = { src: f.rel, dst: dstRel.split('/').map((s) => S.cleanName(s, dst.fstype)).join('/'), size: f.size };
    if (dst.fstype === 'vfat' && f.size > S.FAT_MAX) o.skip = 'fat';
    else if (exists && mode === 'overwrite') o.skip = 'overwrite';
    return o;
  });
  const need = files.filter((f) => f.skip !== 'fat').reduce((a, f) => a + f.size, 0);
  if (need + 8 * 1048576 > dst.free) throw err(`فضای مقصد کافی نیست: ${Math.ceil(need / 1048576)} MB لازم است`);
  if (mode === 'overwrite' && exists) {
    const t = await fs.promises.lstat(path.join(dirAbs, name));
    if (t.isDirectory() !== st.isDirectory()) await fs.promises.rm(path.join(dirAbs, name), { recursive: true, force: true });
  }
  // identity marker only on the (writable) destination, and on the source only for a move
  if (op === 'move') await S.ensureMarker(src).catch(() => {});
  await S.ensureMarker(dst).catch(() => {});
  src.marker = S.readMarker(src.mount); dst.marker = S.readMarker(dst.mount);
  const job = J.create({ kind: op === 'move' ? 'usb_move' : 'usb_copy', uid, title: `${st.isDirectory() ? '📁' : '📄'} ${path.basename(srcAbs)}`, src: S.endpoint(src), dst: S.endpoint(dst), files, data: { srcRoot: op === 'move' ? rel : null } });
  P.audit(uid, 'usb_manage', op, `${src.name}/${rel} -> ${dst.name}/${destRel || '/'}`);
  return { job, files: files.length, need };
}

module.exports = { driveById, busyCheck, copyPlan, copyStart, transfer };
