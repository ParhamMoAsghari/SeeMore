'use strict';
// Persian text for file metadata (meta.inspect output).
const U = require('./util');
const fa = (n) => Number(n).toLocaleString('fa-IR');
const LANG = { fa: 'فارسی', per: 'فارسی', fas: 'فارسی', en: 'انگلیسی', eng: 'انگلیسی', ar: 'عربی', ara: 'عربی', tr: 'ترکی', tur: 'ترکی', fr: 'فرانسوی', fre: 'فرانسوی', fra: 'فرانسوی',
  de: 'آلمانی', ger: 'آلمانی', deu: 'آلمانی', es: 'اسپانیایی', spa: 'اسپانیایی', ru: 'روسی', rus: 'روسی', it: 'ایتالیایی', ita: 'ایتالیایی', ja: 'ژاپنی', jpn: 'ژاپنی',
  ko: 'کره‌ای', kor: 'کره‌ای', zh: 'چینی', chi: 'چینی', zho: 'چینی', hi: 'هندی', hin: 'هندی', pt: 'پرتغالی', por: 'پرتغالی', und: 'نامشخص' };
const lang = (l) => (l ? LANG[String(l).toLowerCase()] || l : 'نامشخص');
function hms(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const kbps = (b) => (b ? (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mb/s` : `${Math.round(b / 1000)} kb/s`) : '');
const res = (v) => (v.height >= 2000 || v.width >= 3800 ? '4K' : v.height >= 1000 || v.width >= 1900 ? '1080p' : v.height >= 700 || v.width >= 1260 ? '720p' : v.height ? `${v.height}p` : '');
const ch = (n) => ({ 1: 'مونو', 2: 'استریو', 6: '5.1', 8: '7.1' }[n] || (n ? `${n} کانال` : ''));
const when = (ms) => (ms ? `${U.jalali(ms)} ${U.hhmm(ms)}` : '-');

function metaText(m, where) {
  const L = [];
  L.push(`${m.isDir ? '📁' : '📄'} ${m.name}`);
  if (where) L.push(`📂 ${where}`);
  L.push('');
  L.push(`📦 حجم: ${U.bytes(m.size)}${m.size >= 1024 ? ` (${fa(m.size)} بایت)` : ''}`);
  if (m.mime) L.push(`🏷 نوع: ${m.mime}${m.charset && m.charset !== 'binary' ? ` · ${m.charset}` : ''}`);
  if (m.description && !m.media) L.push(`ℹ️ ${U.trunc(m.description, 110)}`);
  L.push(`🕒 تغییر: ${when(m.mtime)}`);
  L.push(`🕓 تغییر وضعیت (ctime): ${when(m.ctime)}${m.birthtime ? `\n🐣 ساخت: ${when(m.birthtime)}` : ''}`);
  L.push(`🔐 دسترسی: ${m.modeStr} (${m.mode}) · مالک ${m.owner}`);
  if (m.isLink) L.push(`🔗 پیوند به: ${m.target}`);
  const x = m.media;
  if (x) {
    L.push('', `🎞 ${x.container || x.formatName || ''}${x.duration ? ` · ⏱ ${hms(x.duration)}` : ''}${x.bitrate ? ` · ${kbps(x.bitrate)}` : ''}`);
    if (x.title) L.push(`📝 عنوان داخلی: ${U.trunc(x.title, 80)}`);
    for (const v of x.video) L.push(`📺 ویدیو: ${v.codec}${v.profile ? ` (${v.profile})` : ''} · ${v.width}×${v.height} ${res(v)}${v.fps ? ` · ${v.fps} fps` : ''}${v.bitDepth ? ` · ${v.bitDepth}bit` : ''}${v.hdr ? ` · ${v.hdr}` : ' · SDR'}${v.bitrate ? ` · ${kbps(v.bitrate)}` : ''}`);
    if (x.audio.length) {
      L.push(`🔊 صدا (${fa(x.audio.length)}):`);
      for (const a of x.audio.slice(0, 8)) L.push(`  • ${lang(a.lang)} · ${a.codec}${a.profile && a.profile !== 'LC' ? ` ${a.profile}` : ''} · ${ch(a.channels)}${a.bitrate ? ` · ${kbps(a.bitrate)}` : ''}${a.default ? ' · پیش‌فرض' : ''}${a.title ? ` · ${U.trunc(a.title, 30)}` : ''}`);
      if (x.audio.length > 8) L.push('  • ...');
    }
    if (x.subtitles.length) {
      L.push(`💬 زیرنویس داخلی (${fa(x.subtitles.length)}):`);
      for (const s of x.subtitles.slice(0, 10)) L.push(`  • ${lang(s.lang)} · ${s.codec}${s.forced ? ' · اجباری' : ''}${s.default ? ' · پیش‌فرض' : ''}${s.title ? ` · ${U.trunc(s.title, 30)}` : ''}`);
      if (x.subtitles.length > 10) L.push('  • ...');
    } else if (x.video.length) L.push('💬 زیرنویس داخلی: ندارد');
    if (x.chapters.length) L.push(`📑 فصل‌بندی: ${fa(x.chapters.length)} چپتر${x.chapters[0].title ? ` (${x.chapters.slice(0, 3).map((c) => U.trunc(c.title, 18)).join('، ')}${x.chapters.length > 3 ? '، ...' : ''})` : ''}`);
    if (x.attachments) L.push(`📎 پیوست: ${fa(x.attachments)} (فونت و ...)`);
  }
  const im = m.image;
  if (im) {
    L.push('', `🖼 ابعاد: ${im.width || '?'}×${im.height || '?'}${im.width && im.height ? ` (${((im.width * im.height) / 1e6).toFixed(1)} مگاپیکسل)` : ''}${im.type ? ` · ${im.type}` : ''}`);
    if (im.make || im.model) L.push(`📷 دوربین: ${[im.make, im.model].filter(Boolean).join(' ')}${im.lens ? ` · ${im.lens}` : ''}`);
    if (im.taken) L.push(`📅 زمان عکس: ${im.taken}`);
    const ex = [im.exposure ? `1/${Math.round(1 / im.exposure)}s` : null, im.fnumber ? `f/${im.fnumber}` : null, im.iso ? `ISO ${im.iso}` : null, im.focal ? `${im.focal}mm` : null].filter(Boolean);
    if (ex.length) L.push(`⚙️ ${ex.join(' · ')}`);
    if (im.gps) L.push(`📍 موقعیت: ${im.gps.lat.toFixed(5)}, ${im.gps.lon.toFixed(5)}${im.gps.alt != null ? ` · ارتفاع ${Math.round(im.gps.alt)}m` : ''}`);
    if (im.software) L.push(`🛠 نرم‌افزار: ${U.trunc(im.software, 40)}`);
  }
  const p = m.pdf;
  if (p) {
    L.push('', `📕 PDF${p.version ? ` ${p.version}` : ''} · ${p.pages != null ? `${fa(p.pages)} صفحه` : ''}${p.pageSize ? ` · ${U.trunc(p.pageSize, 40)}` : ''}`);
    if (p.title) L.push(`📝 عنوان: ${U.trunc(p.title, 80)}`);
    if (p.author) L.push(`✍️ نویسنده: ${U.trunc(p.author, 60)}`);
    if (p.creator || p.producer) L.push(`🛠 ${U.trunc([p.creator, p.producer].filter(Boolean).join(' / '), 80)}`);
    if (p.created) L.push(`📅 ساخت: ${p.created}`);
    if (p.encrypted && p.encrypted !== 'no') L.push(`🔒 رمزگذاری: ${p.encrypted}`);
  }
  const a = m.archive;
  if (a) {
    if (a.error) L.push('', `🗜 آرشیو قابل خواندن نیست: ${U.trunc(a.error, 80)}`);
    else {
      L.push('', `🗜 آرشیو: ${fa(a.count)} مورد (${fa(a.files)} فایل) · حجم بازشده ${U.bytes(a.unpacked)}${a.partial ? ' · ناقص یا رمزدار' : ''}`);
      for (const e of a.entries.slice(0, 15)) L.push(`  • ${U.trunc(e.name, 60)}${e.size != null && !e.dir ? ` · ${U.bytes(e.size)}` : ''}`);
      if (a.count > 15) L.push(`  • ... و ${fa(a.count - 15)} مورد دیگر`);
    }
  }
  const t = m.text;
  if (t) {
    L.push('', `📝 متن: کدگذاری ${t.encoding} · ${t.lines != null ? `${fa(t.lines)} خط` : `حدود ${fa(t.linesApprox)} خط`} · زبان احتمالی: ${lang(t.lang)}`);
    if (t.cues != null) L.push(`💬 ${fa(t.cues)} دیالوگ${t.lastCue ? ` · تا ${hms(t.lastCue)}` : ''}`);
    if (t.preview) L.push(`«${U.trunc(t.preview.replace(/\n+/g, ' ⏎ '), 160)}»`);
  }
  if (m.doc) {
    const d = m.doc;
    L.push('', `📄 سند${d.FileType ? ` ${d.FileType}` : ''}${d.Pages ? ` · ${fa(d.Pages)} صفحه` : ''}${d.Words ? ` · ${fa(d.Words)} کلمه` : ''}`);
    if (d.Title) L.push(`📝 عنوان: ${U.trunc(d.Title, 80)}`);
    if (d.Author || d.Creator) L.push(`✍️ ${U.trunc(d.Author || d.Creator, 60)}`);
  }
  if (m.error) L.push('', `⚠️ ${U.trunc(m.error, 100)}`);
  return L.join('\n').slice(0, 3900);
}
module.exports = { metaText, lang, hms };
