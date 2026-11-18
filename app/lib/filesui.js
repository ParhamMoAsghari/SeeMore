'use strict';
// «🗂 فایل‌های سرور»: read-only browser for /data/media, /data/usb-imports, /data/torrents with metadata.
const path = require('path');
const F = require('./files');
const U = require('./util');
const P = require('./perms');
const ctx = require('./ctx');
const { metaText } = require('./metaview');

const btn = (text, cb) => ({ text, callback_data: cb });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const fa = (n) => Number(n).toLocaleString('fa-IR');
const short = (s, n = 36) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const icon = (e) => (e.dir ? '📁' : /\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i.test(e.name) ? '🎞' : /\.(srt|ass|ssa|sub|vtt)$/i.test(e.name) ? '💬' : /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(e.name) ? '🖼' : /\.(zip|rar|7z|tar|gz)$/i.test(e.name) ? '🗜' : /\.pdf$/i.test(e.name) ? '📕' : '📄');
const PAGE = 10;

module.exports = function createFilesUi(bale, store, present, hooks = {}) {
  const d = store.d;
  async function roots(mid) {
    const df = F.df();
    const rows = F.ROOTS.map((r) => [btn(r.label, `fsR:${r.key}`)]);
    rows.push([btn('✖️ بستن', 'close')]);
    return present('files', mid, `🗂 فایل‌های سرور (فقط مشاهده)\n💽 فضای آزاد /data: ${U.bytes(df.free)} از ${U.bytes(df.total)}\n\nروی هر فایل بزن تا مشخصات کاملش (کیفیت، کدک، صدا، زیرنویس، EXIF و ...) را ببینی.`, kb(...rows));
  }
  async function open(mid, key, rel, page = 0) {
    let ents;
    try { ents = await F.list(key, rel); } catch (e) { if (rel) return open(mid, key, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), 0); if (e.code === 'ENOENT') ents = []; else throw e; }
    const pages = Math.max(1, Math.ceil(ents.length / PAGE));
    page = Math.max(0, Math.min(page, pages - 1));
    d.fsb = { key, rel, page, names: ents.map((e) => e.name), dirs: ents.map((e) => e.dir) }; store.save();
    const root = F.rootOf(key);
    const nd = ents.filter((e) => e.dir).length;
    const text = `${root.label}\n📂 ${root.path}${rel ? '/' + rel : ''}\n\n${ents.length ? `📁 ${fa(nd)} پوشه · 📄 ${fa(ents.length - nd)} فایل${pages > 1 ? ` · صفحه‌ی ${fa(page + 1)} از ${fa(pages)}` : ''}` : 'خالی است.'}`;
    const rows = ents.slice(page * PAGE, (page + 1) * PAGE).map((e, i) => [btn(`${icon(e)} ${short(e.name)}${e.dir ? '' : ` · ${U.bytes(e.size)}`}`, `${e.dir ? 'fso' : 'fsf'}:${page * PAGE + i}`)]);
    if (pages > 1) rows.push([btn('◀️', `fsp:${Math.max(0, page - 1)}`), btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'), btn('▶️', `fsp:${Math.min(pages - 1, page + 1)}`)]);
    rows.push([rel ? btn('⬆️ پوشه‌ی بالا', 'fsu') : btn('↩️ ریشه‌ها', 'fsr'), btn('✖️ بستن', 'close')]);
    return present('files', mid, text, kb(...rows));
  }
  const entry = (i) => { const b = d.fsb; if (!b) return null; const n = b.names[Number(i)]; return n == null ? null : { b, name: n, rel: b.rel ? `${b.rel}/${n}` : n }; };
  async function fileView(mid, i) {
    const e = entry(i); if (!e) return roots(mid);
    bale.action('typing');
    const m = await F.inspect(e.b.key, e.rel);
    P.audit(ctx.uid(), 'files', 'inspect', `${e.b.key}/${e.rel}`);
    const rows = [];
    if (e.b.key === 'media' && P.can(ctx.uid(), 'links') && hooks.linkForFile) rows.push([btn('🔗 لینک دانلود این فایل', `fsL:${i}`)]);
    rows.push([btn('↩️ بازگشت', `fsp:${e.b.page}`), btn('✖️ بستن', 'close')]);
    return present('files', mid, metaText(m, `${F.rootOf(e.b.key).path}/${e.rel}`), kb(...rows));
  }
  async function onCallback(cb, a, p) {
    const mid = cb.message.message_id;
    const b = d.fsb;
    switch (a) {
      case 'fsr': await bale.answer(cb.id); return roots(mid);
      case 'fsR': await bale.answer(cb.id); return open(mid, p[0], '', 0);
      case 'fso': { await bale.answer(cb.id); const e = entry(p[0]); if (!e) return roots(mid); return open(mid, e.b.key, e.rel, 0); }
      case 'fsp': await bale.answer(cb.id); if (!b) return roots(mid); return open(mid, b.key, b.rel, Number(p[0]) || 0);
      case 'fsu': { await bale.answer(cb.id); if (!b) return roots(mid); const up = path.posix.dirname(b.rel); return open(mid, b.key, up === '.' ? '' : up, 0); }
      case 'fsf': await bale.answer(cb.id, '🔎'); return fileView(mid, p[0]);
      case 'fsL': { await bale.answer(cb.id); const e = entry(p[0]); if (!e || !hooks.linkForFile) return roots(mid); return hooks.linkForFile(mid, F.resolve(e.b.key, e.rel), e.name); }
      default: return bale.answer(cb.id);
    }
  }
  return { onCallback, roots };
};
