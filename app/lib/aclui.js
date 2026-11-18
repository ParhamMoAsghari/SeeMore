'use strict';
// «👥 کاربران و دسترسی‌ها» (owner only): grants with expiry and fine-grained permissions,
// one-time invite links, revoke/extend/edit, audit log.
const P = require('./perms');
const U = require('./util');
const W = require('./when');
const ctx = require('./ctx');
const { asUser } = require('./fan');

const btn = (text, cb) => ({ text, callback_data: cb });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const fa = (n) => Number(n).toLocaleString('fa-IR');
const short = (s, n = 26) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const until = (t) => (t ? `تا ${U.jalali(t)} ${U.hhmm(t)}` : 'بدون انقضا');
const ST = { active: '🟢', expired: '⌛', revoked: '⛔' };
const ACT = { grant: 'دسترسی داد', update: 'دسترسی را تغییر داد', delete: 'کاربر را حذف کرد', invite: 'لینک دعوت ساخت', invite_delete: 'دعوت را حذف کرد', redeem: 'با دعوت وارد شد', expired: 'دسترسی منقضی شد',
  scan: 'حافظه را بررسی کرد', import: 'انتقال به سرور', copy: 'کپی روی حافظه', move: 'جابه‌جایی', rename: 'تغییر نام', mkdir: 'پوشه ساخت', eject: 'جداسازی', inspect: 'مشخصات فایل', create: 'لینک ساخت', revoke: 'لینک را لغو کرد', extend: 'تمدید' };

module.exports = function createAclUi(bale, store, present) {
  const d = store.d;
  const name = (u) => u.name || (u.username ? '@' + u.username : String(u.uid));
  async function list(mid) {
    const us = P.list();
    const inv = P.invites();
    const rows = us.slice(0, 25).map((u) => [btn(`${P.isActive(u) ? '🟢' : ST[u.status] || '⛔'} ${short(name(u))} · ${fa(u.perms.length)} مجوز`, `acU:${u.uid}`)]);
    rows.push([btn(`➕ افزودن با شناسه‌ی ${bale.label || 'کاربر'}`, 'acA'), btn('🎟 ساخت لینک دعوت', 'acI')]);
    if (inv.length) rows.push([btn(`🎟 دعوت‌های فعال (${fa(inv.length)})`, 'acIV')]);
    rows.push([btn('📜 گزارش فعالیت همه', 'acL:0'), btn('✖️ بستن', 'close')]);
    const act = us.filter((u) => P.isActive(u)).length;
    return present('acl', mid, `👥 کاربران و دسترسی‌ها\n\nربات فقط به شما و کاربرانی که اینجا دسترسی دارند جواب می‌دهد. هر دسترسی مدت و مجوزهای جدا دارد و با تمام شدن مدت، خودکار قطع می‌شود.\n\n🟢 ${fa(act)} فعال · ${fa(us.length - act)} غیرفعال`, kb(...rows));
  }
  function draftText(w) {
    const L = [w.mode === 'invite' ? '🎟 لینک دعوت جدید' : w.mode === 'edit' ? `✏️ ویرایش دسترسی ${w.uid}` : `➕ دسترسی برای ${w.uid}`, ''];
    L.push(`⏳ مدت: ${w.exp === 'custom' && w.until ? until(w.until) : W.PRESET_FA[w.exp] || (w.exp === 'keep' ? 'بدون تغییر' : '')}`);
    if (w.mode === 'invite') L.push(`🎟 اعتبار خود لینک دعوت: ${W.PRESET_FA[w.ttl] || '۱ روز'} (یک‌بار مصرف)`);
    L.push('', 'مجوزها را علامت بزن:');
    return L.join('\n');
  }
  async function draft(mid) {
    const w = d.acw; if (!w) return list(mid);
    const rows = [];
    for (let i = 0; i < P.PERMS.length; i += 2) rows.push(P.PERMS.slice(i, i + 2).map(([k, l]) => btn(`${w.perms.includes(k) ? '✅' : '⬜'} ${l}`, `acP:${k}`)));
    rows.push([btn('👁 فقط تماشا', 'acPr:viewer'), btn('👪 خانواده', 'acPr:family'), btn('⭐ همه', 'acPr:full'), btn('⬜ هیچ', 'acPr:none')]);
    const ex = [['h1', '۱ ساعت'], ['d1', '۱ روز'], ['w1', '۱ هفته'], ['m1', '۱ ماه'], ['m3', '۳ ماه'], ['never', '♾']];
    rows.push(ex.slice(0, 3).map(([k, l]) => btn(`${w.exp === k ? '🔘' : '⏳'} ${l}`, `acE:${k}`)));
    rows.push([...ex.slice(3).map(([k, l]) => btn(`${w.exp === k ? '🔘' : '⏳'} ${l}`, `acE:${k}`)), btn(`${w.exp === 'custom' ? '🔘' : '📅'} تاریخ دلخواه`, 'acE:custom')]);
    if (w.mode === 'edit') rows.push([btn(`${w.exp === 'keep' ? '🔘' : '⚪️'} مدت بدون تغییر`, 'acE:keep')]);
    if (w.mode === 'invite') rows.push([['h1', 'دعوت: ۱ ساعت'], ['d1', 'دعوت: ۱ روز'], ['w1', 'دعوت: ۱ هفته']].map(([k, l]) => btn(`${w.ttl === k ? '🔘' : '⚪️'} ${l}`, `acT:${k}`)));
    rows.push([btn(w.mode === 'invite' ? '🎟 ساخت لینک دعوت' : '💾 ذخیره', 'acS')], [btn('↩️ انصراف', 'acM')]);
    return present('acl', mid, draftText(w), kb(...rows));
  }
  const expOf = (w) => (w.exp === 'custom' ? w.until : w.exp === 'never' ? null : W.fromPreset(w.exp));
  async function save(cb, mid) {
    const w = d.acw; if (!w) return list(mid);
    if (!w.perms.length) return bale.answer(cb.id, 'حداقل یک مجوز را انتخاب کن', true);
    if (w.exp === 'custom' && !w.until) return bale.answer(cb.id, 'تاریخ دلخواه را هنوز نفرستاده‌ای', true);
    const me = ctx.uid();
    if (w.mode === 'invite') {
      const durMs = w.exp === 'custom' ? null : w.exp === 'never' ? null : W.PRESETS[w.exp];
      const inv = P.createInvite({ perms: w.perms, grantDur: durMs, grantUntil: w.exp === 'custom' ? w.until : null, ttl: W.PRESETS[w.ttl || 'd1'], by: me });
      d.acw = null; store.save();
      await bale.answer(cb.id, '🎟 ساخته شد');
      const link = (bale.startLink && bale.startLink(inv.code)) || null;
      return present('acl', mid, `🎟 لینک دعوت (یک‌بار مصرف، معتبر ${until(inv.expires)})\n\n${link ? `${link}\n\nیا ` : ''}طرف مقابل در ربات بفرستد:\n/start ${inv.code}\n\nمجوزها: ${inv.perms.map((k) => P.LABEL[k]).join('، ')}\nمدت دسترسی بعد از ورود: ${w.exp === 'custom' ? until(w.until) : W.PRESET_FA[w.exp]}`, kb([btn('↩️ کاربران', 'acM')]));
    }
    let u;
    if (w.mode === 'edit') u = P.update(w.uid, { perms: w.perms, ...(w.exp === 'keep' ? {} : { expires: expOf(w), status: 'active' }) }, me);
    else u = P.grant({ uid: w.uid, perms: w.perms, expires: expOf(w), by: me });
    d.acw = null; store.save();
    await bale.answer(cb.id, '💾 ذخیره شد');
    if (w.mode !== 'edit') asUser(u.uid, () => bale.send(`👋 به ربات رسانه دسترسی پیدا کردی (${until(u.expires)}).\n/start را بزن.`)).catch(() => {});
    return userView(mid, u.uid);
  }
  async function userView(mid, uid) {
    const u = P.getUser(uid); if (!u) return list(mid);
    const L = [`${P.isActive(u) ? '🟢 فعال' : u.status === 'revoked' ? '⛔ لغوشده' : '⌛ منقضی'} · ${name(u)}`, `🆔 ${u.uid}${u.username ? ` · @${u.username}` : ''}`, `⏳ ${until(u.expires)}`,
      `➕ از ${U.jalali(u.added)}${u.note === 'invite' ? ' (با دعوت)' : ''}${u.last_seen ? ` · آخرین فعالیت ${U.ago(u.last_seen)}` : ''}`, '', '🔑 مجوزها:', ...(u.perms.length ? u.perms.map((k) => `• ${P.LABEL[k]}`) : ['• هیچ'])];
    const rows = [[btn('✏️ ویرایش مجوزها', `acEd:${uid}`), btn('⏳ تمدید', `acX:${uid}`)]];
    if (P.isActive(u)) rows.push([btn('⛔ لغو دسترسی', `acR:${uid}`)]);
    rows.push([btn('📜 فعالیت', `acL:${uid}`), btn('🗑 حذف کامل', `acD:${uid}`)], [btn('↩️ کاربران', 'acM')]);
    return present('acl', mid, L.join('\n'), kb(...rows));
  }
  async function auditView(mid, uid) {
    const rows = Number(uid) ? P.auditFor(uid, 25) : P.auditAll(25);
    const who = (x) => (P.isOwner(x) ? 'شما' : (P.getUser(x) || {}).name || x);
    const text = rows.length ? rows.map((r) => `${U.dayLabel(r.t)} ${U.hhmm(r.t)} · ${Number(uid) ? '' : `${who(r.uid)} · `}${ACT[r.action] || r.action}${r.detail ? ` · ${short(r.detail, 50)}` : ''}`).join('\n') : 'فعالیتی ثبت نشده.';
    return present('acl', mid, `📜 گزارش فعالیت${Number(uid) ? ` ${uid}` : ''}\n\n${text}`.slice(0, 3900), kb([btn('↩️', Number(uid) ? `acU:${uid}` : 'acM')]));
  }
  async function onText(aw, text) {
    if (aw.type === 'acl_uid') {
      const id = Number(String(text).replace(/[۰-۹]/g, (x) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(x)).replace(/\D/g, ''));
      if (!id || P.isOwner(id)) return bale.send(`⚠️ شناسه‌ی عددی کاربر ${bale.label || ''} را بفرست (مثلاً 123456789). کاربر می‌تواند شناسه‌اش را از ربات‌هایی مثل @userinfobot بگیرد یا از لینک دعوت استفاده کن.`);
      const ex = P.getUser(id);
      d.acw = { mode: ex ? 'edit' : 'add', uid: id, perms: ex ? ex.perms : P.PRESETS.viewer.slice(), exp: ex ? 'keep' : 'w1' }; store.save();
      return draft(null);
    }
    if (aw.type === 'acl_date') {
      const t = W.parseWhen(text);
      if (!t || !d.acw) return bale.send('⚠️ تاریخ را نفهمیدم. مثال: 1405/09/10 یا 2026-12-01 یا 10d');
      d.acw.exp = 'custom'; d.acw.until = t; store.save();
      return draft(null);
    }
    return null;
  }
  async function onCallback(cb, a, p) {
    const mid = cb.message.message_id;
    const w = d.acw;
    switch (a) {
      case 'acM': d.acw = null; store.save(); await bale.answer(cb.id); return list(mid);
      case 'acA': await bale.answer(cb.id); d.await = { type: 'acl_uid', until: Date.now() + 300000 }; store.save(); return bale.send(`🆔 شناسه‌ی عددی کاربر در ${bale.label || 'پیام‌رسان'} را بفرست.`);
      case 'acI': await bale.answer(cb.id); d.acw = { mode: 'invite', perms: P.PRESETS.viewer.slice(), exp: 'w1', ttl: 'd1' }; store.save(); return draft(mid);
      case 'acIV': {
        await bale.answer(cb.id);
        const inv = P.invites();
        return present('acl', mid, `🎟 دعوت‌های استفاده‌نشده\n\n${inv.map((x, i) => `${fa(i + 1)}. ${x.perms.length} مجوز · معتبر ${until(x.expires)}`).join('\n')}`, kb(...inv.slice(0, 10).map((x, i) => [btn(`🗑 حذف دعوت ${fa(i + 1)}`, `acID:${x.code.slice(0, 10)}`)]), [btn('↩️', 'acM')]));
      }
      case 'acID': { const x = P.invites().find((y) => y.code.startsWith(p[0])); if (x) P.deleteInvite(x.code, ctx.uid()); await bale.answer(cb.id, '🗑'); return list(mid); }
      case 'acP': if (!w) break; w.perms = w.perms.includes(p[0]) ? w.perms.filter((x) => x !== p[0]) : [...w.perms, p[0]]; store.save(); await bale.answer(cb.id); return draft(mid);
      case 'acPr': if (!w) break; w.perms = p[0] === 'none' ? [] : P.PRESETS[p[0]].slice(); store.save(); await bale.answer(cb.id); return draft(mid);
      case 'acE': if (!w) break; if (p[0] === 'custom') { d.await = { type: 'acl_date', until: Date.now() + 300000 }; store.save(); await bale.answer(cb.id); return bale.send('📅 تاریخ پایان دسترسی را بفرست: مثلاً 1405/09/10 یا 1405/09/10 18:00 یا 2026-12-01 یا 10d'); } w.exp = p[0]; store.save(); await bale.answer(cb.id); return draft(mid);
      case 'acT': if (!w) break; w.ttl = p[0]; store.save(); await bale.answer(cb.id); return draft(mid);
      case 'acS': return save(cb, mid);
      case 'acU': await bale.answer(cb.id); return userView(mid, Number(p[0]));
      case 'acEd': { const u = P.getUser(p[0]); if (!u) break; d.acw = { mode: 'edit', uid: u.uid, perms: u.perms.slice(), exp: 'keep' }; store.save(); await bale.answer(cb.id); return draft(mid); }
      case 'acX': { await bale.answer(cb.id); return present('acl', mid, '⏳ تمدید تا چه مدت از الان؟', kb([btn('۱ روز', `acXx:${p[0]}:d1`), btn('۱ هفته', `acXx:${p[0]}:w1`), btn('۱ ماه', `acXx:${p[0]}:m1`)], [btn('۳ ماه', `acXx:${p[0]}:m3`), btn('♾ بدون انقضا', `acXx:${p[0]}:never`)], [btn('↩️', `acU:${p[0]}`)])); }
      case 'acXx': { const u = P.getUser(p[0]); if (!u) break; P.extend(u.uid, W.fromPreset(p[1]), ctx.uid()); await bale.answer(cb.id, '⏳ تمدید شد'); asUser(u.uid, () => bale.send(`⏳ دسترسی شما به ربات تمدید شد (${until(P.getUser(u.uid).expires)}).`)).catch(() => {}); return userView(mid, u.uid); }
      case 'acR': { const u = P.getUser(p[0]); if (!u) break; P.revoke(u.uid, ctx.uid()); await bale.answer(cb.id, '⛔ لغو شد'); return userView(mid, u.uid); }
      case 'acD': { await bale.answer(cb.id); return present('acl', mid, `🗑 کاربر ${p[0]} کامل حذف شود؟ (گزارش فعالیتش می‌ماند)`, kb([btn('✅ بله', `acDD:${p[0]}`), btn('↩️ نه', `acU:${p[0]}`)])); }
      case 'acDD': P.remove(Number(p[0]), ctx.uid()); await bale.answer(cb.id, '🗑 حذف شد'); return list(mid);
      case 'acL': await bale.answer(cb.id); return auditView(mid, Number(p[0]));
      default: break;
    }
    return bale.answer(cb.id);
  }
  return { onCallback, onText, list };
};
