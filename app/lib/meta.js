'use strict';
// File metadata for any file type (service layer; returns plain objects). Tools from the image:
// file, ffprobe, exiftool, pdfinfo, bsdtar, uchardet. Every external call has a timeout.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const sh = (cmd, args, { timeout = 15000, max = 4 * 1048576 } = {}) => new Promise((res) => {
  execFile(cmd, args, { timeout, maxBuffer: max, encoding: 'buffer' }, (err, out, errOut) => res({ ok: !err, out: out ? out.toString('utf8') : '', err: errOut ? errOut.toString('utf8') : '', code: err && err.code }));
});
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv|3gp|vob)$/i;
const AUDIO = /\.(mp3|flac|m4a|aac|wav|ogg|opus|wma|ac3|dts|mka)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|cr2|nef|arw|dng)$/i;
const ARCH = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|tbz2|txz|iso|cab)$/i;
const SUB = /\.(srt|ass|ssa|sub|vtt|idx|sup|smi)$/i;
const TEXT = /\.(txt|nfo|log|md|csv|json|xml|ini|cfg|conf|yml|yaml|html?|srt|ass|ssa|vtt|sub|smi)$/i;

const UIDS = { 0: 'root', [Number(process.env.PUID || 1000)]: process.env.PUSER || 'user' };
const modeStr = (m) => {
  const t = (m & 0o170000) === 0o040000 ? 'd' : (m & 0o170000) === 0o120000 ? 'l' : '-';
  let s = '';
  for (let i = 8; i >= 0; i--) s += (m >> i) & 1 ? 'rwx'[(8 - i) % 3] : '-';
  return t + s;
};

async function basic(p) {
  const st = await fsp.lstat(p);
  const r = { path: p, name: path.basename(p), size: st.size, isDir: st.isDirectory(), isLink: st.isSymbolicLink(),
    mtime: st.mtimeMs, ctime: st.ctimeMs, atime: st.atimeMs, birthtime: st.birthtimeMs || null,
    mode: (st.mode & 0o777).toString(8).padStart(3, '0'), modeStr: modeStr(st.mode), uid: st.uid, gid: st.gid,
    owner: `${UIDS[st.uid] || st.uid}:${UIDS[st.gid] || st.gid}`, inode: st.ino, links: st.nlink };
  if (r.isLink) { try { r.target = await fsp.readlink(p); } catch {} }
  const f = await sh('file', ['-b', '--mime-type', '--mime-encoding', '--', p], { timeout: 8000 });
  if (f.ok) { const [mime, enc] = f.out.trim().split(/;\s*charset=/); r.mime = mime; r.charset = enc; }
  const d = await sh('file', ['-b', '--', p], { timeout: 8000 });
  if (d.ok) r.description = d.out.trim().slice(0, 200);
  return r;
}

const num = (x) => (x == null || x === '' || isNaN(Number(x)) ? null : Number(x));
async function media(p) {
  const r = await sh('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '--', p], { timeout: 30000 });
  if (!r.ok) return null;
  let j; try { j = JSON.parse(r.out); } catch { return null; }
  const f = j.format || {};
  const out = { container: f.format_long_name || f.format_name, formatName: f.format_name, duration: num(f.duration), bitrate: num(f.bit_rate),
    title: f.tags && (f.tags.title || f.tags.TITLE), video: [], audio: [], subtitles: [], attachments: 0, chapters: [] };
  for (const s of j.streams || []) {
    const tags = s.tags || {};
    const lang = tags.language || tags.LANGUAGE || null;
    if (s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) {
      const hdr = s.color_transfer === 'smpte2084' ? 'HDR10' : s.color_transfer === 'arib-std-b67' ? 'HLG' : null;
      const dv = (s.side_data_list || []).some((x) => /dovi|dolby vision/i.test(x.side_data_type || ''));
      const fr = s.avg_frame_rate && s.avg_frame_rate.includes('/') ? (() => { const [a, b] = s.avg_frame_rate.split('/').map(Number); return b ? a / b : null; })() : null;
      out.video.push({ codec: s.codec_name, profile: s.profile, width: s.width, height: s.height, fps: fr ? Math.round(fr * 1000) / 1000 : null,
        bitDepth: num(s.bits_per_raw_sample) || (/10/.test(s.pix_fmt || '') ? 10 : /12/.test(s.pix_fmt || '') ? 12 : 8), pixFmt: s.pix_fmt,
        hdr: dv ? (hdr ? `Dolby Vision + ${hdr}` : 'Dolby Vision') : hdr, bitrate: num(s.bit_rate || tags.BPS), lang });
    } else if (s.codec_type === 'audio') {
      out.audio.push({ codec: s.codec_name, profile: s.profile, channels: s.channels, layout: s.channel_layout, sampleRate: num(s.sample_rate),
        bitrate: num(s.bit_rate || tags.BPS), lang, title: tags.title || null, default: !!(s.disposition && s.disposition.default) });
    } else if (s.codec_type === 'subtitle') {
      out.subtitles.push({ codec: s.codec_name, lang, title: tags.title || null, forced: !!(s.disposition && s.disposition.forced), default: !!(s.disposition && s.disposition.default) });
    } else if (s.codec_type === 'attachment') out.attachments++;
  }
  for (const c of j.chapters || []) out.chapters.push({ start: num(c.start_time), end: num(c.end_time), title: (c.tags && c.tags.title) || null });
  return out;
}

async function image(p) {
  const r = await sh('exiftool', ['-j', '-n', '-ImageWidth', '-ImageHeight', '-Make', '-Model', '-LensModel', '-DateTimeOriginal', '-CreateDate', '-GPSLatitude', '-GPSLongitude', '-GPSAltitude',
    '-ExposureTime', '-FNumber', '-ISO', '-FocalLength', '-Orientation', '-Software', '-ColorSpace', '-BitsPerSample', '-FileType', '--', p], { timeout: 15000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out)[0] || {};
    return { width: j.ImageWidth, height: j.ImageHeight, type: j.FileType, make: j.Make, model: j.Model, lens: j.LensModel, taken: j.DateTimeOriginal || j.CreateDate || null,
      gps: j.GPSLatitude != null && j.GPSLongitude != null ? { lat: j.GPSLatitude, lon: j.GPSLongitude, alt: j.GPSAltitude ?? null } : null,
      exposure: j.ExposureTime, fnumber: j.FNumber, iso: j.ISO, focal: j.FocalLength, orientation: j.Orientation, software: j.Software, bits: j.BitsPerSample };
  } catch { return null; }
}

async function pdf(p) {
  const r = await sh('pdfinfo', ['--', p], { timeout: 15000 });
  if (!r.ok) return null;
  const o = {};
  for (const line of r.out.split('\n')) { const m = line.match(/^([^:]+):\s*(.*)$/); if (m) o[m[1].trim()] = m[2].trim(); }
  return { pages: num(o.Pages), title: o.Title || null, author: o.Author || null, subject: o.Subject || null, creator: o.Creator || null, producer: o.Producer || null,
    created: o.CreationDate || null, modified: o.ModDate || null, pageSize: o['Page size'] || null, encrypted: o.Encrypted || null, version: o['PDF version'] || null };
}

async function archive(p) {
  const r = await sh('bsdtar', ['-tvf', p], { timeout: 30000, max: 16 * 1048576 });
  if (!r.ok && !r.out) return { error: (r.err || '').trim().slice(0, 150) || 'unreadable' };
  const lines = r.out.split('\n').filter(Boolean);
  const entries = [];
  let total = 0;
  for (const l of lines) {
    const m = l.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    if (m) { const sz = Number(m[2]); total += sz; entries.push({ name: m[3], size: sz, dir: m[1].startsWith('d') }); }
    else entries.push({ name: l, size: null });
  }
  return { count: entries.length, files: entries.filter((e) => !e.dir).length, unpacked: total, entries: entries.slice(0, 40), partial: !r.ok };
}

const PERSIAN_ONLY = /[پچژگ]/g, ARABIC_SCRIPT = /[\u0600-\u06FF]/g, LATIN = /[A-Za-z]/g, CYR = /[\u0400-\u04FF]/g;
function guessLang(s) {
  const a = (s.match(ARABIC_SCRIPT) || []).length, l = (s.match(LATIN) || []).length, c = (s.match(CYR) || []).length;
  if (a > l && a > c) return (s.match(PERSIAN_ONLY) || []).length > a * 0.005 || /[یک]/.test(s) ? 'fa' : 'ar';
  if (c > l) return 'ru';
  if (l) return 'en';
  return null;
}
async function decodeText(p, maxBytes = 512 * 1024) {
  const fd = await fsp.open(p, 'r');
  let buf;
  try { const b = Buffer.alloc(maxBytes); const { bytesRead } = await fd.read(b, 0, maxBytes, 0); buf = b.subarray(0, bytesRead); } finally { await fd.close(); }
  let enc = null, text;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { enc = 'UTF-8 (BOM)'; text = buf.subarray(3).toString('utf8'); }
  else if (buf[0] === 0xff && buf[1] === 0xfe) { enc = 'UTF-16LE'; text = new TextDecoder('utf-16le').decode(buf); }
  else if (buf[0] === 0xfe && buf[1] === 0xff) { enc = 'UTF-16BE'; text = new TextDecoder('utf-16be').decode(buf); }
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); enc = /[^\x00-\x7f]/.test(text) ? 'UTF-8' : 'ASCII'; }
    catch {
      const u = await sh('uchardet', [p], { timeout: 8000 });
      enc = (u.ok && u.out.trim()) || 'WINDOWS-1256';
      try { text = new TextDecoder(enc.toLowerCase()).decode(buf); } catch { enc = 'WINDOWS-1256'; text = new TextDecoder('windows-1256').decode(buf); }
    }
  }
  return { enc, text, truncated: buf.length >= maxBytes };
}
async function textInfo(p, size) {
  const { enc, text, truncated } = await decodeText(p);
  const lines = text.split(/\r?\n/);
  const out = { encoding: enc, lines: truncated ? null : lines.length, linesApprox: truncated ? Math.round(lines.length * (size / (512 * 1024))) : null, lang: guessLang(text), preview: text.replace(/\r/g, '').slice(0, 300) };
  if (SUB.test(p)) {
    const cues = (text.match(/^\s*\d+\s*\r?\n\s*\d\d:\d\d:\d\d[,.]\d+\s*-->/gm) || []).length || (text.match(/^Dialogue:/gm) || []).length;
    const times = [...text.matchAll(/(\d\d):(\d\d):(\d\d)[,.](\d+)\s*-->/g)];
    const last = times.length ? times[times.length - 1] : null;
    out.cues = cues; out.lastCue = last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null;
  }
  return out;
}

async function inspect(p) {
  const b = await basic(p);
  if (b.isDir) return b;
  const n = b.name, mime = b.mime || '';
  try {
    if (VIDEO.test(n) || AUDIO.test(n) || /^(video|audio)\//.test(mime)) b.media = await media(p);
    else if (IMAGE.test(n) || /^image\//.test(mime)) b.image = await image(p);
    else if (/\.pdf$/i.test(n) || mime === 'application/pdf') b.pdf = await pdf(p);
    else if (ARCH.test(n) || /(zip|rar|7z|x-tar|gzip|bzip2|xz|iso9660)/.test(mime)) b.archive = await archive(p);
    else if (TEXT.test(n) || SUB.test(n) || /^text\//.test(mime)) b.text = await textInfo(p, b.size);
    else {
      // documents (office etc.) and anything exiftool understands
      const r = await sh('exiftool', ['-j', '-Title', '-Author', '-Creator', '-Pages', '-Words', '-Company', '-CreateDate', '-ModifyDate', '-FileType', '--', p], { timeout: 15000 });
      if (r.ok) { try { const j = JSON.parse(r.out)[0] || {}; delete j.SourceFile; if (Object.keys(j).length > 1) b.doc = j; } catch {} }
    }
  } catch (e) { b.error = e.message; }
  return b;
}

module.exports = { inspect, basic, media, image, pdf, archive, textInfo, decodeText, guessLang, VIDEO, AUDIO, IMAGE, ARCH, SUB };
