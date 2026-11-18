// Persian labels for settings keys and groups (fallback: the English description from the API).
export const GROUPS = {
  features: 'قابلیت‌ها', bot: 'ربات', notify: 'اعلان‌ها', requests: 'درخواست دانلود', links: 'لینک‌های دانلود', panel: 'پنل و ورود',
  schedule: 'زمان‌بندی‌ها', usb: 'حافظه‌های خارجی', jobs: 'کارها', backup: 'پشتیبان', acl: 'دسترسی', jellyfin: 'Jellyfin', ctl: 'کنترل کانتینرها',
  domains: 'دامنه‌ها', net: 'پورت‌ها', container: 'کانتینر', sso: 'ورود یکپارچه', subfa: 'زیرنویس فارسی (subf2m)', qbit: 'qBittorrent',
};
export const LABELS = {
  'features.usb': 'بخش حافظه‌های خارجی', 'features.usb_import': 'انتقال از حافظه به سرور', 'features.usb_manage': 'مدیریت فایل روی حافظه (جابه‌جایی/حذف)',
  'features.files': 'مرور فایل‌های سرور', 'features.links': 'لینک دانلود', 'features.links_rar': 'فرمت RAR برای لینک‌ها', 'features.requests': 'جست‌وجو و درخواست دانلود', 'features.notify': 'اعلان‌های رسانه',
  'links.public_base': 'آدرس عمومی لینک‌ها', 'links.lan_base': 'آدرس داخلی لینک‌ها', 'links.rate_per_min': 'سقف درخواست در دقیقه برای هر IP', 'links.max_parallel': 'سقف دانلود هم‌زمان هر IP',
  'links.bad_token_block': 'توکن نامعتبر تا مسدودسازی ۱۰ دقیقه‌ای IP', 'links.rar_min_free_mb': 'فضای آزاد لازم هنگام ساخت RAR (MB)',
  'jellyfin.public_url': 'آدرس Jellyfin در پیام‌ها', 'acl.refusal_text': 'پیام به کاربران بدون دسترسی', 'backup.keep_days': 'نگه‌داری پشتیبان‌ها (روز)', 'backup.dir': 'پوشه‌ی پشتیبان',
  'usb.default_mode': 'حالت پیش‌فرض حافظه‌ی تازه وصل‌شده (protected = فقط‌خواندنی و بدون هیچ نوشتن)', 'usb.auto_repair': 'تعمیر خودکار هنگام وصل شدن (فقط حافظه‌های قابل نوشتن)',
  'usb.ignore_label_regex': 'نادیده گرفتن حافظه‌ها با برچسب (regex)', 'jobs.progress_every_s': 'فاصله‌ی به‌روزرسانی پیشرفت در ربات (ثانیه)',
  'panel.session_hours': 'مدت نشست پنل (ساعت)', 'panel.lock_after': 'تلاش ناموفق تا قفل حساب', 'panel.lock_minutes': 'مدت قفل (دقیقه)', 'panel.ip_lock_after': 'تلاش ناموفق هر IP در ساعت تا مسدودسازی',
  'bot.menu_hidden': 'دکمه‌های پنهان در منوی ربات', 'notify.types': 'نوع اعلان‌های ارسالی', 'bot.messenger': 'پیام‌رسان ربات', 'bot.token_env': 'نام متغیر محیطی توکن', 'bot.update_mode': 'روش دریافت پیام‌ها (polling یا webhook)', 'bot.webhook_url': 'آدرس عمومی webhook (https)', 'bot.webhook_port': 'پورت گیرنده‌ی webhook داخل کانتینر',
  'schedule.backup_check_min': 'بررسی پشتیبان روزانه (دقیقه)', 'schedule.grant_sweep_s': 'بررسی انقضای دسترسی‌ها (ثانیه)', 'schedule.checkpoint_min': 'checkpoint پایگاه‌داده (دقیقه)',
  'requests.quality_m': 'کیفیت پیش‌فرض فیلم', 'requests.quality_s': 'کیفیت پیش‌فرض سریال', 'requests.root_m': 'پوشه‌ی ریشه‌ی فیلم‌ها', 'requests.root_s': 'پوشه‌ی ریشه‌ی سریال‌ها',
  'domains.panel_public': 'دامنه‌ی عمومی پنل (https)', 'domains.panel_lan': 'دامنه‌ی داخلی پنل (http)', 'domains.dl_public': 'دامنه‌ی عمومی لینک‌ها (https)', 'domains.dl_lan': 'دامنه‌ی داخلی لینک‌ها (http)',
  'sso.enabled': 'ورود یکپارچه از پنل به سرویس‌ها', 'sso.public_domain': 'دامنه‌ی والد عمومی سرویس‌ها (https)', 'sso.lan_domain': 'دامنه‌ی والد داخلی سرویس‌ها (http)',
  'sso.oidc': 'ارائه‌دهنده‌ی OpenID Connect روی پنل', 'sso.oidc_issuer': 'آدرس ثابت صادرکننده‌ی OIDC (خالی = همان میزبان درخواست)',
  'sso.jellyfin_deny': 'حساب‌های Jellyfin که ورود OIDC هرگز نباید به آن‌ها وارد شود', 'sso.jellyfin_libraries': 'کتابخانه‌های Jellyfin برای حساب تازه‌ساخته‌شده', 'sso.jellyfin_map': 'نگاشت دقیق نام کاربری پنل به حساب موجود Jellyfin',
  'net.api_port': 'پورت API و پنل (داخل شبکه‌ی داکر)', 'net.links_port': 'پورت سرور لینک‌ها', 'container.mem_limit': 'سقف حافظه‌ی کانتینر', 'container.panel_bind': 'انتشار پورت پنل روی میزبان (فقط IP خصوصی)',
  'ctl.restartable': 'کانتینرهای قابل ری‌استارت از پنل',
  'subfa.ENABLED': 'فعال بودن subf2m', 'subfa.POLL_SECONDS': 'بررسی سریع (ثانیه)', 'subfa.SWEEP_SECONDS': 'بررسی کامل (ثانیه)', 'subfa.BAZARR_GRACE': 'مهلت Bazarr پیش از subf2m (ثانیه)',
  'subfa.BACKOFF_HOURS': 'فاصله‌ی تلاش‌های دوباره (ساعت، با کاما)', 'subfa.SUBF2M_GAP': 'حداقل فاصله‌ی درخواست‌ها به subf2m (ثانیه)', 'subfa.NOTIFY': 'اعلان در ربات بعد از افزودن زیرنویس',
  'qbit.dl_limit': 'سقف سرعت دانلود', 'qbit.up_limit': 'سقف سرعت آپلود', 'qbit.alt_dl_limit': 'سقف دانلود حالت جایگزین', 'qbit.alt_up_limit': 'سقف آپلود حالت جایگزین',
  'qbit.queueing_enabled': 'صف تورنت‌ها', 'qbit.max_active_downloads': 'حداکثر دانلود فعال', 'qbit.max_active_uploads': 'حداکثر آپلود فعال', 'qbit.max_active_torrents': 'حداکثر تورنت فعال',
  'qbit.max_connec': 'حداکثر اتصال کل', 'qbit.max_connec_per_torrent': 'حداکثر اتصال هر تورنت', 'qbit.max_uploads': 'حداکثر اسلات آپلود', 'qbit.max_ratio_enabled': 'توقف seed با رسیدن به نسبت',
  'qbit.max_ratio': 'نسبت seed', 'qbit.max_seeding_time_enabled': 'توقف seed بعد از زمان', 'qbit.max_seeding_time': 'زمان seed (دقیقه)', 'qbit.scheduler_enabled': 'زمان‌بندی سرعت جایگزین', 'qbit.dht': 'DHT', 'qbit.pex': 'تبادل همتا (PEX)',
};
export const CLS = {
  hot: ['فوری', 'ok', 'بلافاصله اعمال می‌شود؛ بدون ری‌استارت.'],
  reload: ['ری‌استارت سرویس', 'warn', 'سرویس مربوط چند ثانیه ری‌استارت می‌شود.'],
  recreate: ['ساخت دوباره‌ی کانتینر', 'err', 'کانتینر با تنظیمات تازه دوباره ساخته می‌شود؛ ربات و پنل حدود ۱۰ تا ۳۰ ثانیه در دسترس نیستند.'],
  caddy: ['بارگذاری Caddy', 'pri', 'پیکربندی Caddy دوباره ساخته، اعتبارسنجی و بدون قطعی بارگذاری می‌شود؛ اگر Caddy نپذیرد، مقدار قبلی برمی‌گردد.'],
};
export const MENU_KEYS = [['search', '🔎 جست‌وجو'], ['dl', '📥 دانلودها'], ['lib', '🎬 کتابخانه'], ['news', '🆕 تازه‌ها'], ['cal', '📅 تقویم'], ['srv', '⚙️ سرور'], ['usb', '💾 حافظه‌ها'], ['files', '🗂 فایل‌ها'], ['links', '🔗 لینک‌ها'], ['acl', '👥 کاربران'], ['help', '❓ راهنما']];
export const NOTIFY_TYPES = [['grab', 'شروع دانلود'], ['import', 'اضافه شدن به آرشیو'], ['failed', 'خطای دانلود'], ['health', 'سلامت سرویس‌ها'], ['manual', 'نیاز به اقدام دستی'], ['subtitle', 'زیرنویس'], ['outage', 'قطعی سرویس']];
