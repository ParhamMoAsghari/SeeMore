'use strict';
// Expiry helpers: preset durations and parsing of a custom date typed by the user
// (Jalali 1405/09/10 [14:30], Gregorian 2026-12-01 [14:30], or relative: 3d, 12h, 2w, 1m, «۳ روز»).
const H = 3600000, D = 24 * H;
const PRESETS = { h1: H, d1: D, w1: 7 * D, m1: 30 * D, m3: 90 * D };
const PRESET_FA = { h1: '۱ ساعت', d1: '۱ روز', w1: '۱ هفته', m1: '۱ ماه', m3: '۳ ماه', never: 'بدون انقضا' };
const toEn = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
function j2g(jy, jm, jd) {
  jy += 1595; let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0; for (gm = 0; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}
// Tehran is UTC+03:30 all year
const tehran = (y, m, d, hh = 23, mm = 59) => Date.UTC(y, m - 1, d, hh, mm) - 3.5 * H;
function parseWhen(text) {
  const s = toEn(text).trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hour|hours|ساعت|d|day|days|روز|w|week|weeks|هفته|m|month|months|ماه)$/);
  if (m) { const n = Number(m[1]); const u = m[2]; const ms = /^(h|hour|hours|ساعت)$/.test(u) ? H : /^(d|day|days|روز)$/.test(u) ? D : /^(w|week|weeks|هفته)$/.test(u) ? 7 * D : 30 * D; return Date.now() + n * ms; }
  m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hh = m[4] != null ? Number(m[4]) : 23, mm = m[5] != null ? Number(m[5]) : 59;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y < 1700) [y, mo, d] = j2g(y, mo, d);
  const t = tehran(y, mo, d, hh, mm);
  return t > Date.now() ? t : null;
}
const fromPreset = (k) => (k === 'never' ? null : Date.now() + (PRESETS[k] || D));
module.exports = { parseWhen, fromPreset, PRESETS, PRESET_FA, j2g };
