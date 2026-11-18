'use strict';
// Text and keyboard builders (pure functions, no I/O).
const U = require('./util');
const { MENU } = require('./config');
const M = require('./media');

const btn = (text, cb) => ({ text, callback_data: cb });
const url = (text, u) => ({ text, url: u });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });

const MENU_KB = {
  keyboard: [
    [{ text: MENU.search }, { text: MENU.dl }],
    [{ text: MENU.lib }, { text: MENU.news }],
    [{ text: MENU.cal }, { text: MENU.srv }],
    [{ text: MENU.usb }, { text: MENU.help }],
  ],
  resize_keyboard: true, is_persistent: true,
};

const HELP = `🎬 ربات مدیریت رسانه

🔎 اسم فیلم یا سریال را بفرست تا نتیجه‌ها را با پوستر ببینی و با یک دکمه دانلودش کنی.
از دکمه‌های ◀️ ▶️ بین نتیجه‌ها جابه‌جا شو. برای سریال می‌توانی فصل‌ها را یکی‌یکی انتخاب کنی.

📥 دانلودها: پیشرفت زنده، سرعت، زمان باقی‌مانده و دکمه‌های توقف، ادامه، حذف و انتخاب نسخه‌ی دیگر
🎬 کتابخانه: فیلم‌ها و سریال‌های موجود، وضعیت فایل و زیرنویس، جست‌وجوی دوباره و حذف
🆕 تازه‌ها: آخرین موارد آماده‌شده و اضافه‌شده
📅 تقویم پخش: قسمت‌ها و فیلم‌هایی که به‌زودی می‌آیند
⚙️ وضعیت سرور: دیسک، رم، سرویس‌ها و ایندکسرها
💾 فلش: فلش یا هارد را به سرور وصل کن تا محتوایش را ببینی، قسمت‌ها یا فیلم‌های دلخواه را با نمایش درصد پیشرفت رویش کپی کنی و در پایان با امنیت جدایش کنی

دستورها: /movie اسم فیلم، /tv اسم سریال، /status، /library، /new، /calendar، /server، /usb، /help

وقتی دانلودی شروع شود، آماده شود یا مشکلی پیش بیاید خودم خبرت می‌کنم.`;

// per-user main menu and help (only what the user's permissions allow)
const MENU_PERM = { search: 'request', dl: 'downloads', lib: 'library', news: 'library', cal: 'calendar', srv: 'server', usb: 'usb_view', files: 'files', links: 'links', acl: 'admin', help: 'any' };
function menuKb(perms) {
  let hidden = []; try { hidden = require('./settings').list('bot.menu_hidden'); } catch {}
  const has = (k) => !hidden.includes(k) && (MENU_PERM[k] === 'any' || perms.has(MENU_PERM[k]));
  const order = ['search', 'dl', 'lib', 'news', 'cal', 'srv', 'usb', 'files', 'links', 'acl', 'help'].filter(has);
  const rows = [];
  for (let i = 0; i < order.length; i += 2) rows.push(order.slice(i, i + 2).map((k) => ({ text: MENU[k] })));
  return { keyboard: rows, resize_keyboard: true };
}
const HELP_LINES = [
  ['request', '🔎 اسم فیلم یا سریال را بفرست تا نتیجه‌ها را با پوستر ببینی و با یک دکمه دانلودش کنی.'],
  ['downloads', '📥 دانلودها: پیشرفت زنده، سرعت، زمان باقی‌مانده و توقف، ادامه، حذف'],
  ['library', '🎬 کتابخانه و 🆕 تازه‌ها: فیلم‌ها و سریال‌های موجود، وضعیت فایل و زیرنویس'],
  ['calendar', '📅 تقویم پخش: قسمت‌ها و فیلم‌هایی که به‌زودی می‌آیند'],
  ['server', '⚙️ وضعیت سرور: دیسک، رم، سرویس‌ها و ایندکسرها'],
  ['usb_view', '💾 حافظه‌های خارجی: فلش و هارد وصل‌شده، مرور فایل‌ها و مشخصات هر فایل، کپی فیلم و سریال رویش با درصد پیشرفت، جابه‌جایی و تغییر نام، 📤 انتقال به سرور (فیلم و سریال خودکار در آرشیو مرتب می‌شوند) و جداسازی امن'],
  ['files', '🗂 فایل‌های سرور: مرور آرشیو، ورودی‌های فلش و تورنت‌ها با مشخصات کامل هر فایل (فقط مشاهده)'],
  ['links', '🔗 لینک دانلود: ساخت لینک ZIP/RAR برای فیلم، قسمت یا فصل‌های کامل، با یا بدون انقضا، داخل و بیرون شبکه'],
  ['admin', '👥 کاربران و دسترسی‌ها: دادن دسترسی موقت با مجوزهای جدا، لینک دعوت، لغو و تمدید، گزارش فعالیت'],
];
function helpFor(perms) {
  const l = HELP_LINES.filter(([p]) => perms.has(p)).map(([, t]) => t);
  return `🎬 ربات مدیریت رسانه\n\n${l.join('\n\n')}\n\nدستورها: /start /menu /help${perms.has('request') ? ' /movie /tv' : ''}${perms.has('downloads') ? ' /status' : ''}${perms.has('library') ? ' /library /new' : ''}${perms.has('usb_view') ? ' /usb' : ''}${perms.has('links') ? ' /links' : ''}${perms.has('notify') ? '\n\nوقتی دانلودی شروع شود، آماده شود یا مشکلی پیش بیاید خبرت می‌کنم.' : ''}`;
}

// ---------- item cards ----------
function ratingLine(it) {
  const p = [];
  if (it.k === 'm') {
    if (it.imdb) p.push(`IMDb ${Number(it.imdb).toFixed(1)}`);
    if (it.tmdb) p.push(`TMDB ${Number(it.tmdb).toFixed(1)}`);
    if (it.rt) p.push(`RT ${Math.round(it.rt)}%`);
  } else if (it.rating) p.push(`امتیاز ${Number(it.rating).toFixed(1)}`);
  return p.length ? `⭐ ${p.join(' · ')}` : '';
}
const SERIES_STATUS = { continuing: 'در حال پخش', ended: 'پایان‌یافته', upcoming: 'به‌زودی', deleted: 'حذف‌شده' };
function headline(it) { return `${it.k === 'm' ? '🎬' : '📺'} ${it.title}${it.year ? ` (${it.year})` : ''}`; }
function metaLines(it) {
  const l = [];
  const r = ratingLine(it); if (r) l.push(r);
  const bits = [];
  if (it.runtime) bits.push(`⏱ ${U.runtime(it.runtime)}${it.k === 's' ? ' هر قسمت' : ''}`);
  if (it.k === 's') {
    if (it.seasonCount) bits.push(`📚 ${it.seasonCount} فصل`);
    if (SERIES_STATUS[it.status]) bits.push(`📡 ${SERIES_STATUS[it.status]}`);
  }
  if (it.cert) bits.push(`🔞 ${it.cert}`);
  if (bits.length) l.push(bits.join(' · '));
  const g = U.genresFa(it.genres); if (g) l.push(`🎭 ${g}`);
  const co = it.k === 'm' ? it.studio : it.network;
  if (co) l.push(`🏢 ${co}`);
  return l;
}
function libState(it) {
  if (!it.libId) return '🆕 در کتابخانه نیست';
  if (it.k === 'm') return it.hasFile ? '✅ در کتابخانه است و قابل تماشاست' : '⏳ در کتابخانه است و منتظر دانلود';
  return it.epTotal && it.eps >= it.epTotal ? '✅ در کتابخانه است (کامل)' : `⏳ در کتابخانه است (${it.eps}/${it.epTotal} قسمت)`;
}
function caption(it, { state = true } = {}) {
  const head = [headline(it), ...metaLines(it)].join('\n');
  const ov = it.overview ? `\n\n${U.trunc(it.overview, 330)}` : '\n\nخلاصه‌ای موجود نیست.';
  return `${head}${ov}${state ? `\n\n${libState(it)}` : ''}`.slice(0, 1000);
}

function searchKb(it, sid, idx, total) {
  const rows = [];
  rows.push(it.libId ? [btn('📂 مدیریت در کتابخانه', `li:${it.k}:${it.libId}`)] : [btn('⬇️ دانلود', `a:${it.ref}:${sid}.${idx}`)]);
  if (total > 1) rows.push([btn('◀️ قبلی', `n:${sid}:${(idx - 1 + total) % total}`), btn(`${idx + 1} از ${total}`, 'noop'), btn('بعدی ▶️', `n:${sid}:${(idx + 1) % total}`)]);
  rows.push([btn('✖️ بستن', 'close')]);
  return kb(...rows);
}

// ---------- download flow steps ----------
function modeKb(it, ctx) {
  return kb(
    [btn('📚 همه‌ی فصل‌ها', `mo:${it.ref}:all`), btn('🆕 فقط آخرین فصل', `mo:${it.ref}:last`)],
    [btn('⏭ فقط قسمت‌های آینده', `mo:${it.ref}:fut`), btn('☑️ انتخاب فصل‌ها', `mo:${it.ref}:sel`)],
    [btn('↩️ بازگشت', `x:${it.ref}`)],
  );
}
function seasonKb(it, sel) {
  const rows = [];
  for (let i = 0; i < it.seasons.length; i += 5) {
    rows.push(it.seasons.slice(i, i + 5).map((n) => btn(`${sel.includes(n) ? '✅' : '⬜'} ${n}`, `t:${it.ref}:${n}`)));
  }
  rows.push([btn('انتخاب همه', `ts:${it.ref}:all`), btn('پاک کردن', `ts:${it.ref}:none`)]);
  rows.push([btn(`➡️ ادامه (${sel.length} فصل)`, `ts:${it.ref}:ok`)], [btn('↩️ بازگشت', `a:${it.ref}`)]);
  return kb(...rows);
}
function qualityKb(it, opts, backCb) {
  return kb(...opts.map((o) => [btn(o.label, `q:${it.ref}:${o.k}`)]), [btn('↩️ بازگشت', backCb)]);
}
function modeText(flow, it) {
  if (it.k === 'm') return '';
  return { all: 'همه‌ی فصل‌ها', last: `آخرین فصل (${it.seasons[it.seasons.length - 1] || '؟'})`, fut: 'فقط قسمت‌های آینده',
    sel: `فصل‌های ${[...(flow.seasons || [])].sort((a, b) => a - b).join('، ')}` }[flow.mode] || '';
}
function confirmText(it, flow, quality) {
  const l = ['📋 خلاصه‌ی درخواست', '', headline(it)];
  if (it.k === 's') l.push(`📚 ${modeText(flow, it)}`);
  l.push(`🎞 کیفیت: ${quality.name}`, `📁 پوشه: ${it.k === 'm' ? '/data/media/movies' : '/data/media/tv'}`, '', 'اضافه شود و دانلود شروع شود؟');
  return l.join('\n');
}
const confirmKb = (it) => kb([btn('✅ تایید و دانلود', `y:${it.ref}`)], [btn('🎞 تغییر کیفیت', `mo:${it.ref}:q`), btn('✖️ انصراف', `x:${it.ref}`)]);

// ---------- downloads ----------
function dlText(d) {
  const lines = ['📥 دانلودها'];
  const tr = d.transfer;
  if (tr) lines.push(`⬇️ ${U.speed(tr.dl_info_speed)} · ⬆️ ${U.speed(tr.up_info_speed)}`);
  lines.push('');
  if (!d.items.length) lines.push(d.errors.length ? `⚠️ ${d.errors[0]}` : '✅ الان دانلودی در جریان نیست.');
  const shown = d.items.slice(0, 8);
  shown.forEach((it, i) => {
    lines.push(`${U.numEmoji(i + 1)} ${it.k === 'm' ? '🎬' : '📺'} ${it.name}${it.sub ? ` · ${it.sub}` : ''}`);
    const parts = [`${U.bar(it.progress)} ${Math.floor(it.progress)}%`];
    if (it.speed) parts.push(U.speed(it.speed));
    lines.push(parts.join(' · '));
    const meta = [];
    if (it.eta != null) meta.push(`⏱ ${U.dur(it.eta)}`); else if (it.etaText) meta.push(`⏱ ${it.etaText}`);
    if (it.seeds != null) meta.push(`👥 ${it.seeds} سید`);
    if (it.size) meta.push(`💾 ${U.bytes(it.size)}`);
    lines.push(meta.join(' · ') || '');
    lines.push(`وضعیت: ${it.paused ? '⏸ ' : ''}${it.state}`);
    for (const w of it.warnings) lines.push(`⚠️ ${U.trunc(w, 120)}`);
    lines.push('');
  });
  if (d.items.length > shown.length) lines.push(`و ${d.items.length - shown.length} مورد دیگر`);
  lines.push(`🕐 به‌روز شده ${U.hhmmss(Date.now())}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 3900);
}
function dlKb(d, live) {
  const rows = [];
  d.items.slice(0, 8).filter((i) => i.hash).forEach((it, i) => {
    const h = it.hash.slice(0, 12);
    rows.push([
      btn(`${it.paused ? '▶️' : '⏸'} ${i + 1}`, `dq:${it.paused ? 'r' : 'p'}:${h}`),
      btn(`🔀 ${i + 1}`, `dq:a:${h}`),
      btn(`🗑 ${i + 1}`, `dq:x:${h}`),
    ]);
  });
  rows.push([btn('🔄 تازه‌سازی', 'st'), btn('✖️ بستن', 'close')]);
  if (!d.items.length) rows.push([btn('🆕 تازه‌ها', 'new'), btn('📅 تقویم', 'cal:7')]);
  return kb(...rows);
}
function dlRemoveText(it) {
  return `🗑 حذف دانلود\n\n${it.k === 'm' ? '🎬' : '📺'} ${it.name}${it.sub ? ` · ${it.sub}` : ''}\n\nدانلود از صف و از qBittorrent حذف می‌شود. می‌خواهی این نسخه برای دفعه‌های بعد نادیده گرفته شود؟`;
}
function dlRemoveKb(it) {
  const h = it.hash.slice(0, 12);
  return kb([btn('🗑 حذف و نادیده گرفتن این نسخه', `dq:xx:${h}:1`)], [btn('🗑 فقط حذف', `dq:xx:${h}:0`)], [btn('↩️ انصراف', 'st')]);
}

// ---------- releases ----------
const REL_PAGE = 6;
function relText(rs, page) {
  const total = Math.max(1, Math.ceil(rs.list.length / REL_PAGE));
  const l = [`🔀 نسخه‌های «${rs.label}»`, 'مرتب‌شده بر اساس تعداد سیدر', ''];
  rs.list.slice(page * REL_PAGE, (page + 1) * REL_PAGE).forEach((r, i) => {
    l.push(`${U.numEmoji(i + 1)} ${r.quality}${r.pack ? ' · بسته‌ی کامل' : ''} · ${U.bytes(r.size)}`);
    l.push(`👥 ${r.seeders} سید · ${r.indexer}${r.age != null ? ` · ${r.age} روز پیش` : ''}`);
    l.push(U.trunc(r.title, 70));
    if (r.rejected) l.push(`⚠️ ${U.trunc(r.why || 'رد شده توسط پروفایل', 80)}`);
    l.push('');
  });
  l.push(`صفحه‌ی ${page + 1} از ${total} · ${rs.list.length} نسخه`);
  return l.join('\n').slice(0, 3900);
}
function relKb(rid, rs, page) {
  const total = Math.max(1, Math.ceil(rs.list.length / REL_PAGE));
  const n = rs.list.slice(page * REL_PAGE, (page + 1) * REL_PAGE).length;
  const rows = [Array.from({ length: n }, (_, i) => btn(String(i + 1), `rg:${rid}:${page * REL_PAGE + i}`))];
  if (total > 1) rows.push([btn('◀️', `rel:${rid}:${(page - 1 + total) % total}`), btn(`${page + 1}/${total}`, 'noop'), btn('▶️', `rel:${rid}:${(page + 1) % total}`)]);
  rows.push([btn('✖️ بستن', 'close')]);
  return kb(...rows);
}

// ---------- library ----------
const LIB_PAGE = 6;
function libListView(ctx, items, total) {
  const pages = Math.max(1, Math.ceil(items.length / LIB_PAGE));
  const page = Math.min(ctx.page, pages - 1);
  const flt = { all: 'همه', done: 'آماده', wait: 'منتظر دانلود' }[ctx.filter];
  const head = `${ctx.k === 'm' ? '🎬 فیلم‌ها' : '📺 سریال‌ها'} (${total})${ctx.term ? ` · جست‌وجو: «${ctx.term}»` : ''}\nفیلتر: ${flt} · صفحه‌ی ${page + 1} از ${pages}`;
  const rows = items.slice(page * LIB_PAGE, (page + 1) * LIB_PAGE).map((it) => {
    const done = it.k === 'm' ? it.hasFile : it.epTotal > 0 && it.eps >= it.epTotal;
    const tag = it.k === 'm' ? (done ? '✅' : '⏳') : `${done ? '✅' : '⏳'} ${it.eps}/${it.epTotal}`;
    return [btn(U.trunc(`${tag} ${it.title}${it.year ? ` (${it.year})` : ''}`, 48), `li:${it.k}:${it.libId}`)];
  });
  if (pages > 1) rows.push([btn('◀️', `lp:${(page - 1 + pages) % pages}`), btn(`${page + 1}/${pages}`, 'noop'), btn('▶️', `lp:${(page + 1) % pages}`)]);
  rows.push(['all', 'done', 'wait'].map((f) => btn(`${ctx.filter === f ? '🔘' : '⚪'} ${{ all: 'همه', done: 'آماده', wait: 'منتظر' }[f]}`, `lf:${f}`)));
  rows.push([btn(ctx.k === 'm' ? '📺 سریال‌ها' : '🎬 فیلم‌ها', `lib:${ctx.k === 'm' ? 's' : 'm'}`), btn('🔎 جست‌وجو', 'lib:q')], [btn('✖️ بستن', 'close')]);
  const empty = items.length ? '' : '\n\nچیزی پیدا نشد.';
  return { text: head + empty, kb: kb(...rows), page };
}
const libMenuKb = () => kb([btn('🎬 فیلم‌ها', 'lib:m'), btn('📺 سریال‌ها', 'lib:s')], [btn('🔎 جست‌وجو در کتابخانه', 'lib:q')], [btn('✖️ بستن', 'close')]);

function fileLines(o, bz) {
  const l = [];
  if (!o.hasFile) { l.push('📦 فایلی هنوز دانلود نشده'); }
  else {
    const f = o.movieFile || {};
    const mi = f.mediaInfo || {};
    const bits = [(f.quality && f.quality.quality && f.quality.quality.name) || '', U.bytes(f.size || o.sizeOnDisk)];
    const codec = [mi.videoCodec, mi.videoBitDepth ? `${mi.videoBitDepth}bit` : ''].filter(Boolean).join(' ');
    if (codec) bits.push(codec);
    l.push(`📦 ${bits.filter(Boolean).join(' · ')}`);
  }
  if (bz) {
    if (bz.have && bz.have.length) l.push(`💬 زیرنویس: ${bz.have.join('، ')}`);
    else if (o.hasFile) l.push(`💬 زیرنویس: ${bz.missing && bz.missing.length ? `در انتظار ${bz.missing.join('، ')}` : 'ندارد'}`);
  }
  return l;
}
function libCaption(k, o, extra) {
  const it = M.norm(k, o);
  const head = [headline(it), ...metaLines(it).slice(0, 3)];
  const body = [];
  if (k === 'm') body.push(...fileLines(o, extra.bz));
  else {
    const st = o.statistics || {};
    body.push(`📦 ${st.episodeFileCount || 0}/${st.episodeCount || 0} قسمت · ${U.bytes(st.sizeOnDisk)}`);
    if (extra.bz && extra.bz.epTotal) body.push(`💬 زیرنویس: ${extra.bz.epHave}/${extra.bz.epTotal} قسمت${extra.bz.epMissing ? ` (${extra.bz.epMissing} در انتظار)` : ''}`);
    if (o.nextAiring) body.push(`📅 قسمت بعد: ${U.dayLabel(o.nextAiring)} ${U.hhmm(o.nextAiring)}`);
  }
  body.push(`${o.monitored ? '👁 پایش فعال' : '🙈 پایش خاموش'} · ${extra.profile || ''}`.trim());
  if (extra.dl) body.push(`📥 در حال دانلود: ${Math.floor(extra.dl.progress)}%${extra.dl.speed ? ` · ${U.speed(extra.dl.speed)}` : ''}`);
  const ov = it.overview ? `\n\n${U.trunc(it.overview, 220)}` : '';
  return `${head.join('\n')}\n\n${body.join('\n')}${ov}`.slice(0, 1000);
}
function libKb(k, o, jf) {
  const id = o.id;
  const rows = [[url(jf.deep ? '▶️ پخش در Jellyfin' : '▶️ باز کردن Jellyfin', jf.url)]];
  const r2 = [btn('🔄 جست‌وجوی مجدد', `lr:${k}:${id}`), btn('🔀 نسخه‌ها', `lrl:${k}:${id}`)];
  rows.push(r2);
  if (k === 's') rows.push([btn('📚 فصل‌ها', `lse:${id}`)]);
  rows.push([btn('🗑 حذف', `lx:${k}:${id}`), btn('↩️ فهرست', 'lp:back')]);
  return kb(...rows);
}
function seasonsView(o) {
  const l = [`📚 فصل‌های «${o.title}»`, ''];
  const rows = [];
  for (const s of (o.seasons || []).filter((x) => x.seasonNumber > 0)) {
    const st = s.statistics || {};
    const done = st.totalEpisodeCount && st.episodeFileCount >= st.totalEpisodeCount;
    l.push(`فصل ${s.seasonNumber}: ${done ? '✅' : '⏳'} ${st.episodeFileCount || 0}/${st.totalEpisodeCount || 0}${s.monitored ? '' : ' (پایش خاموش)'}`);
    rows.push([btn(`🔍 جست‌وجوی فصل ${s.seasonNumber}`, `lss:${o.id}:${s.seasonNumber}`), btn(`🔀 نسخه‌ها`, `lrl:s:${o.id}:${s.seasonNumber}`)]);
  }
  rows.push([btn('↩️ بازگشت', `lit:s:${o.id}`)]);
  return { text: l.join('\n'), kb: kb(...rows) };
}
function delText(k, o) {
  return `🗑 حذف «${o.title}»؟\n\nمی‌توانی فقط از کتابخانه حذفش کنی و فایل‌ها بمانند، یا فایل‌های دانلودشده هم پاک شوند. این کار برگشت‌پذیر نیست.`;
}
const delKb = (k, id) => kb([btn('🗑 حذف با فایل‌ها', `lxx:${k}:${id}:1`)], [btn('📂 حذف فقط از کتابخانه', `lxx:${k}:${id}:0`)], [btn('↩️ انصراف', `lit:${k}:${id}`)]);

// ---------- calendar / recent / server ----------
function calText(c, days) {
  const l = [`📅 برنامه‌ی ${days === 7 ? 'این هفته' : `${days} روز آینده`}`, ''];
  if (!c.days.length) l.push(c.errors ? '⚠️ دریافت تقویم با مشکل روبه‌رو شد.' : 'برنامه‌ای در این بازه نیست.');
  for (const d of c.days) {
    const lab = U.dayLabel(d.when);
    l.push(`🗓 ${['امروز', 'فردا', 'دیروز'].includes(lab) ? `${lab} · ` : ''}${U.jalali(d.when)}`);
    l.push(...d.lines); l.push('');
  }
  return l.join('\n').slice(0, 3900);
}
const calKb = (days) => kb([[7, 14, 30].map((n) => btn(`${n === days ? '🔘' : '⚪'} ${n === 7 ? 'هفته' : n + ' روز'}`, `cal:${n}`))][0], [btn('🔄 تازه‌سازی', `cal:${days}`), btn('✖️ بستن', 'close')]);

function newText(r) {
  const l = ['🆕 تازه‌ها', ''];
  l.push('✅ آخرین موارد آماده‌شده');
  if (!r.imported.length) l.push('هنوز چیزی دانلود و ایمپورت نشده.');
  for (const x of r.imported) l.push(`${x.k === 'm' ? '🎬' : '📺'} ${x.title} · ${U.ago(x.date)}`);
  l.push('', '➕ آخرین موارد اضافه‌شده');
  for (const x of r.added) l.push(`${x.k === 'm' ? '🎬' : '📺'} ${x.title} ${x.done ? '✅' : '⏳'} · ${U.ago(x.date)}`);
  if (!r.added.length) l.push('کتابخانه خالی است.');
  return l.join('\n').slice(0, 3900);
}
function newKb(r) {
  const seen = new Set(); const rows = [];
  for (const x of [...r.imported, ...r.added]) { const key = x.k + x.id; if (seen.has(key) || rows.length >= 5) continue; seen.add(key); rows.push([btn(U.trunc(`${x.k === 'm' ? '🎬' : '📺'} ${x.title}`, 45), `li:${x.k}:${x.id}`)]); }
  rows.push([btn('🔄 تازه‌سازی', 'new'), btn('✖️ بستن', 'close')]);
  return kb(...rows);
}

function srvText(s) {
  const l = ['⚙️ وضعیت سرور', ''];
  l.push(`⏱ روشن از ${U.dur(s.up)} پیش`);
  if (s.mem.total) { const used = s.mem.total - s.mem.avail; l.push(`🧠 رم: ${U.bytes(used)} از ${U.bytes(s.mem.total)}\n${U.bar((used / s.mem.total) * 100)} ${Math.round((used / s.mem.total) * 100)}%`); }
  if (s.load.length) l.push(`🔥 بار پردازنده: ${s.load.map((x) => x.toFixed(2)).join(' · ')} (${s.cores} هسته)`);
  if (s.disk) { const used = s.disk.totalSpace - s.disk.freeSpace; l.push(`💾 دیسک: ${U.bytes(s.disk.freeSpace)} آزاد از ${U.bytes(s.disk.totalSpace)}\n${U.bar((used / s.disk.totalSpace) * 100)} ${Math.round((used / s.disk.totalSpace) * 100)}% پر`); }
  if (s.tr) l.push(`🌐 qBittorrent: ${s.tr.connection_status === 'connected' ? 'متصل' : s.tr.connection_status === 'firewalled' ? '⚠️ پشت فایروال (پورت 6881 را چک کن)' : 'قطع'} · DHT ${s.tr.dht_nodes}`);
  l.push('', '🧩 سرویس‌ها');
  for (const [n, r] of s.services) l.push(`${r.ok ? '✅' : '❌'} ${n}${r.ok ? ` · ${r.ms}ms` : ' · در دسترس نیست'}`);
  const en = s.idx.filter((i) => i.enable);
  const bad = en.filter((i) => i.st && i.st.disabledTill && new Date(i.st.disabledTill) > new Date());
  l.push('', `🧲 ایندکسرها: ${en.length - bad.length} از ${en.length} سالم${bad.length ? ` · ⚠️ ${bad.map((i) => i.name).join('، ')}` : ''}`);
  if (s.warnings.length) { l.push('', '⚠️ هشدارها'); for (const w of s.warnings.slice(0, 5)) l.push(`${w.src}: ${U.trunc(w.m, 140)}`); }
  else l.push('', '✅ هشداری وجود ندارد');
  l.push('', `🕐 ${U.hhmmss(Date.now())}`);
  return l.join('\n').slice(0, 3900);
}
const srvKb = () => kb([btn('🔄 تازه‌سازی', 'srv'), btn('🧲 ایندکسرها', 'idx')], [btn('✖️ بستن', 'close')]);
function idxText(s) {
  const l = ['🧲 ایندکسرها', ''];
  for (const i of s.idx) {
    const off = i.st && i.st.disabledTill && new Date(i.st.disabledTill) > new Date();
    l.push(`${!i.enable ? '⚪ غیرفعال' : off ? '⚠️ موقتاً خاموش' : '✅ سالم'} · ${i.name}${off ? ` (تا ${U.hhmm(i.st.disabledTill)})` : ''}`);
  }
  if (!s.idx.length) l.push('ایندکسری تنظیم نشده.');
  return l.join('\n');
}

module.exports = { btn, url, kb, MENU_KB, HELP, menuKb, helpFor, MENU_PERM, caption, searchKb, modeKb, seasonKb, qualityKb, confirmText, confirmKb, modeText, dlText, dlKb, dlRemoveText, dlRemoveKb, relText, relKb, libListView, libMenuKb, libCaption, libKb, seasonsView, delText, delKb, calText, calKb, newText, newKb, srvText, srvKb, idxText, headline };
