// Formatting helpers (Persian digits, Jalali calendar via Intl — no extra libraries).
const faNum = new Intl.NumberFormat('fa-IR');
export const n = (x) => (x == null || Number.isNaN(Number(x)) ? '—' : faNum.format(x));
export function bytes(b) {
  if (b == null) return '—';
  const u = ['بایت', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${faNum.format(Math.round(v * (v < 10 && i ? 10 : 1)) / (v < 10 && i ? 10 : 1))} ${u[i]}`;
}
export const speed = (b) => (b ? `${bytes(b)}/ث` : '—');
export function dur(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${n(h)} ساعت ${m ? `و ${n(m)} دقیقه` : ''}`;
  if (m) return `${n(m)} دقیقه${s && m < 10 ? ` و ${n(s)} ثانیه` : ''}`;
  return `${n(s)} ثانیه`;
}
const jFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' });
const jFmtT = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const jDay = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' });
const hm = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
const ok = (d) => d != null && d !== '' && !Number.isNaN(new Date(d).getTime());
export const date = (d) => (ok(d) ? jFmt.format(new Date(d)) : '—');
export const dateTime = (d) => (ok(d) ? jFmtT.format(new Date(d)) : '—');
export const dayLabel = (d) => (ok(d) ? jDay.format(new Date(d)) : '—');
export const time = (d) => (ok(d) ? hm.format(new Date(d)) : '—');
export function ago(t) {
  if (!ok(t)) return '—';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 0) { const f = -s; if (f < 3600) return `${n(Math.ceil(f / 60))} دقیقه‌ی دیگر`; if (f < 86400) return `${n(Math.round(f / 3600))} ساعت دیگر`; return `${n(Math.round(f / 86400))} روز دیگر`; }
  if (s < 60) return 'همین حالا';
  if (s < 3600) return `${n(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${n(Math.floor(s / 3600))} ساعت پیش`;
  return `${n(Math.floor(s / 86400))} روز پیش`;
}
export const pct = (a, b) => (b ? Math.min(100, Math.max(0, (a / b) * 100)) : 0);
export const sxe = (s, e) => `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
export const JOB_STATE = { queued: 'در صف', running: 'در حال انجام', verifying: 'بررسی صحت', committing: 'ثبت نهایی', completed: 'تمام شد', failed: 'ناموفق', paused: 'متوقف', waiting_for_device: 'منتظر حافظه', canceled: 'لغو شد' };
export const JOB_KIND = { to_usb: 'کپی روی حافظه', usb_copy: 'کپی بین حافظه‌ها', usb_move: 'جابه‌جایی بین حافظه‌ها', import: 'انتقال به آرشیو', usb_import: 'انتقال به آرشیو' };
