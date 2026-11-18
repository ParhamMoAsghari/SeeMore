'use strict';
// Shared helpers: logging with redaction, retry/backoff, Persian formatting.

const SECRET_NAME = /(TOKEN|KEY|PASS)/;
const secrets = Object.entries(process.env)
  .filter(([k, v]) => SECRET_NAME.test(k) && v && v.length >= 6)
  .map(([, v]) => v);

function redact(s) {
  s = String(s);
  for (const v of secrets) if (s.includes(v)) s = s.split(v).join('***');
  return s.replace(/bot\d+:[\w-]+/g, 'bot***');
}

function log(level, msg, fields) {
  const o = { t: new Date().toISOString(), level, msg: redact(msg) };
  if (fields) { try { Object.assign(o, JSON.parse(redact(JSON.stringify(fields)))); } catch {} }
  (level === 'error' ? console.error : console.log)(JSON.stringify(o));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { tries = 4, base = 1000, max = 15000, shouldRetry = () => true } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      err = e;
      if (i === tries - 1 || !shouldRetry(e)) break;
      const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(max, base * 2 ** i);
      await sleep(wait * (0.85 + Math.random() * 0.3));
    }
  }
  throw err;
}

// ---------- formatting ----------
function bytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const speed = (n) => `${bytes(n)}/s`;

function dur(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return 'کمتر از یک دقیقه';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} روز${h ? ` و ${h} ساعت` : ''}`;
  if (h) return `${h} ساعت${m ? ` و ${m} دقیقه` : ''}`;
  if (m) return `${m} دقیقه`;
  return 'کمتر از یک دقیقه';
}
function runtime(min) {
  min = Number(min) || 0;
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} ساعت${m ? ` و ${m} دقیقه` : ''}` : `${m} دقیقه`;
}
function bar(pct, len = 10) {
  pct = Math.max(0, Math.min(100, Number(pct) || 0));
  const f = Math.round((pct / 100) * len);
  return '▓'.repeat(f) + '░'.repeat(len - f);
}
function trunc(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const i = cut.lastIndexOf(' ');
  return (i > n * 0.6 ? cut.slice(0, i) : cut).replace(/[\s,.;:،-]+$/, '') + '...';
}

const TZ = 'Asia/Tehran';
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTimeS = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtYMD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtJalali = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const fmtJalaliShort = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, day: 'numeric', month: 'long' });
const hhmm = (d) => fmtTime.format(new Date(d));
const hhmmss = (d) => fmtTimeS.format(new Date(d));
const ymd = (d) => fmtYMD.format(new Date(d));
const jalali = (d) => fmtJalali.format(new Date(d));
function dayLabel(d) {
  const t = ymd(Date.now()), x = ymd(d);
  if (x === t) return 'امروز';
  if (x === ymd(Date.now() + 86400000)) return 'فردا';
  if (x === ymd(Date.now() - 86400000)) return 'دیروز';
  return fmtJalaliShort.format(new Date(d));
}
function ago(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 90) return 'همین الان';
  if (s < 3600) return `${Math.round(s / 60)} دقیقه پیش`;
  if (s < 86400) return `${Math.round(s / 3600)} ساعت پیش`;
  return `${Math.round(s / 86400)} روز پیش`;
}

const GENRES = {
  Action: 'اکشن', Adventure: 'ماجراجویی', Animation: 'انیمیشن', Comedy: 'کمدی', Crime: 'جنایی', Documentary: 'مستند',
  Drama: 'درام', Family: 'خانوادگی', Fantasy: 'فانتزی', History: 'تاریخی', Horror: 'ترسناک', Music: 'موسیقی',
  Musical: 'موزیکال', Mystery: 'معمایی', Romance: 'عاشقانه', 'Science Fiction': 'علمی‌تخیلی', 'Sci-Fi': 'علمی‌تخیلی',
  'Sci-Fi & Fantasy': 'علمی‌تخیلی و فانتزی', 'TV Movie': 'فیلم تلویزیونی', Thriller: 'هیجانی', War: 'جنگی', Western: 'وسترن',
  Reality: 'واقعی', Talk: 'گفت‌وگو', Anime: 'انیمه', 'Mini-Series': 'مینی‌سریال', Sport: 'ورزشی', Suspense: 'تعلیق',
  Biography: 'زندگی‌نامه', Kids: 'کودک', News: 'خبری', Soap: 'سریال خانگی', 'War & Politics': 'جنگ و سیاست',
  'Action & Adventure': 'اکشن و ماجراجویی', 'Game Show': 'مسابقه‌ای', 'Game-Show': 'مسابقه‌ای', Holiday: 'تعطیلات',
};
const genresFa = (g) => (g || []).slice(0, 4).map((x) => GENRES[x] || x).join('، ');

const NUM = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const numEmoji = (n) => (n >= 0 && n <= 9 ? NUM[n] : `${n}.`);
const pad2 = (n) => String(n).padStart(2, '0');
const sxe = (s, e) => `S${pad2(s)}E${pad2(e)}`;

function shortId(len = 4) {
  return Math.random().toString(36).slice(2, 2 + len);
}

module.exports = { redact, log, sleep, retry, bytes, speed, dur, runtime, bar, trunc, hhmm, hhmmss, ymd, jalali, dayLabel, ago, genresFa, numEmoji, pad2, sxe, shortId, TZ };
