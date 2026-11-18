'use strict';
const E = process.env;
module.exports = {
  TOKEN: E.TELEGRAM_TOKEN || E.BALE_TOKEN,
  CHAT: Number(E.ALLOWED_CHAT || 0),
  // live: settings 'jellyfin.public_url' (DB) > env JELLYFIN_URL > default
  get JELLYFIN_PUBLIC() { try { return String(require('./settings').get('jellyfin.public_url')).replace(/\/$/, ''); } catch { return (E.JELLYFIN_URL || '').replace(/\/$/, ''); } },
  HOOK_KEY: E.HOOK_KEY || '',
  PORT: Number(E.PORT || 3000),
  STATE_FILE: E.STATE_FILE || '/state/state.json',
  POSTER_PROXY: 'https://wsrv.nl/?w=500&output=jpg&url=',
  MENU: {
    search: '🔎 جست‌وجو', dl: '📥 دانلودها', lib: '🎬 کتابخانه', news: '🆕 تازه‌ها',
    cal: '📅 تقویم پخش', srv: '⚙️ وضعیت سرور', help: '❓ راهنما', usb: '💾 حافظه‌های خارجی', usbOld: '💾 فلش',
    files: '🗂 فایل‌های سرور', links: '🔗 لینک دانلود', acl: '👥 کاربران و دسترسی‌ها',
  },
};
