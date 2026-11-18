# seemore

[![CI](https://github.com/ParhamMoAsghari/SeeMore/actions/workflows/ci.yml/badge.svg)](https://github.com/ParhamMoAsghari/SeeMore/actions/workflows/ci.yml)

**Self-hosted media automation & management platform.** seemore covers the whole life of a movie or a series on your
own server — and lets you run all of it from a **Telegram bot** or a **web panel**:

```
Discovery → Acquisition → Organization → Subtitles → Streaming → Sharing → Archiving
  search     qBittorrent    Radarr/Sonarr   Bazarr +     Jellyfin    ZIP/RAR      USB drives,
  + request  via *arr       naming/folders  subfa (fa)              links        imports, backups
```

Instead of re-implementing Radarr, Sonarr or Jellyfin, seemore is an integrated management layer on top of them,
adding what they do not have: a messenger bot, a Persian web panel, external-drive copy and import, share links,
users with fine-grained permissions, runtime configuration and a durable job engine that survives power loss.

**New in 1.1.0:** write-protected USB mode with health checks, a responsive panel, and single sign-on (the panel
is the hub for Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent and Jellyfin via OIDC, with a per-user Services
launcher; every service keeps its own username and password). See the [changelog](CHANGELOG.md).

[فارسی ↓](#فارسی)

## Features
- **One central core** (single source of truth) with a **domain API** (`/api/v1`, OpenAPI) — the bot and the panel
  are clients of it; permissions, jobs and the audit log are identical everywhere.
- **Telegram bot** (default; **Bale** optional): search with posters, quality and season choice, requests, library,
  live downloads, Jalali calendar, server status, notifications. Polling or webhook mode.
- **React panel** — Persian, RTL, dark/light, mobile — with every bot feature plus users, settings and health.
- **External drives:** auto-mount, read-only by default, browse, metadata of any file, move/rename/delete on a
  writable drive, copy chosen movies/episodes/seasons with subtitles and live progress (%, speed, ETA), safe eject.
- **Single sign-on:** the panel opens Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent and Jellyfin for the people you
  allow; each app keeps its own login as a fallback.
- **Imports from drives:** movies and series are recognised and imported through Radarr/Sonarr, so they match the
  archive's naming and folders; other files go to a separate folder.
- **Share links:** one or many movies, episodes or full seasons as a streamed ZIP (resumable) or RAR, with expiry,
  download limits and revoke, for the public internet and the LAN.
- **Users & permissions:** only you and the people you grant, for a set time, with a separate permission per area
  and per media service.
- **Runtime configuration:** domains, ports, feature flags, bot, indexers, subtitle providers, torrent limits — changed
  live in the panel, with change classes (hot / reload / recreate / Caddy), confirmation, history and rollback.
- **Fail-proof by design:** durable jobs (`queued → running → verifying → committing → completed`), atomic writes,
  verification, idempotency, recovery after power cuts, outbox for notifications, device identity for drives.
- **Portable:** one `docker-compose.yml` with profiles, `.env.example` documenting every variable, `install.sh`,
  `Makefile`, host installer; no host-specific values in the repo.

## Quick start
Requirements: Linux, Docker + Compose v2.20+, a data disk at `/data` (configurable). Full guide:
[docs/installation.md](docs/installation.md).
```sh
git clone https://github.com/ParhamMoAsghari/SeeMore.git /opt/seemore && cd /opt/seemore
sh install.sh                        # .env with random internal secrets, docker network, folders, permissions
$EDITOR .env                      # TELEGRAM_TOKEN, ALLOWED_CHAT, JELLYFIN_PASS, API keys, domains
sudo make host                    # optional: USB auto-mount + runtime-settings helper (udev/systemd)
docker compose build seemore && docker compose up -d
```
Then finish the first-start steps of the media apps ([installation.md](docs/installation.md#first-start-of-the-media-services-profile-media)),
send `/start` to your bot and open `https://<PANEL_PUBLIC_HOST>`.

Profiles (`COMPOSE_PROFILES` in `.env`): core always; `media` (Jellyfin, Seerr, Radarr, Sonarr, Prowlarr,
qBittorrent, Bazarr, FlareSolverr); `subfa` (Persian subtitles); `proxy` (Caddy, automatic HTTPS). Leave out what you
already run elsewhere and point the `*_URL` variables at it. In filtered networks see [docs/iran.md](docs/iran.md).

## Repository layout
| path | what |
|---|---|
| `app/` | core process (Node ≥ 22, no dependencies): bot, API + panel server, job engine, importer, link server |
| `panel/` | React panel source (Vite); built into the image |
| `subfa/` | Persian subtitle service (Python stdlib) |
| `host/` | udev/systemd helpers (USB auto-mount, seemore-ctl) + `install.sh` / `uninstall.sh` |
| `config/` | `Caddyfile.example` |
| `compose/` | optional overlays (`iran.yml`) |
| `docs/` | documentation for every component ([index](docs/README.md)) |
| `docker-compose.yml`, `Dockerfile`, `.env.example`, `install.sh`, `Makefile` | deployment |
| `TESTS.md`, `CHANGELOG.md`, `RELEASE_NOTES.md` | test evidence, changes, known limitations |

## Documentation
[Architecture](docs/architecture.md) · [Installation](docs/installation.md) · [API](docs/api.md) ·
[Panel](docs/panel.md) · [Telegram bot](docs/bot-telegram.md) · [Bale bot](docs/bot-bale.md) ·
[Job engine](docs/job-engine.md) · [USB](docs/usb.md) · [Imports](docs/imports.md) · [Share links](docs/shares.md) ·
[subfa](docs/subfa.md) · [Permissions](docs/permissions.md) · [Settings](docs/settings.md) ·
[SSO](docs/sso.md) ([فارسی](docs/sso.fa.md)) · [USB protection](docs/usb-protection.md) ·
[Security](docs/security.md) · [Recovery](docs/recovery.md) · [Backup](docs/backup-restore.md) ·
[Upgrading](docs/upgrading.md) · [Troubleshooting](docs/troubleshooting.md) · [Tests](TESTS.md)

## Status
v1.1.0 adds single sign-on, write-protected USB mode and the responsive panel. Known limitations are listed in
[CHANGELOG.md](CHANGELOG.md#known-limitations).

## License
**Personal / noncommercial use only.** seemore is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE): you may use, change and share it for personal and other
noncommercial purposes; commercial use needs a separate written licence from the copyright holder. Third-party
components keep their own licences ([NOTICE.md](NOTICE.md)).

---

<div dir="rtl">

## فارسی

**seemore** یک سامانه‌ی خودمیزبان برای خودکارسازی و مدیریت کامل رسانه است: از پیدا کردن و دانلود فیلم و سریال
تا مرتب‌سازی، زیرنویس فارسی، پخش، اشتراک‌گذاری و انتقال به فلش و هارد — همه از طریق **ربات تلگرام** (یا بله) و
**پنل وب فارسی**.

چرخه‌ی کامل: **کشف ← دریافت ← سازمان‌دهی ← زیرنویس ← پخش ← اشتراک‌گذاری ← آرشیو**

seemore به‌جای بازنویسی Radarr، Sonarr و Jellyfin، یک لایه‌ی یکپارچه‌ی مدیریت و اتوماسیون روی همین سرویس‌های
تخصصی است.

### امکانات
- **هسته‌ی مرکزی و API دامنه‌ای:** ربات و پنل فقط کلاینت‌های یک هسته‌اند؛ مجوزها، کارها و گزارش فعالیت همه‌جا یکسان است.
- **ربات تلگرام** (پیش‌فرض) و **ربات بله** (اختیاری): جست‌وجو با پوستر، انتخاب کیفیت و فصل، درخواست دانلود، کتابخانه،
  دانلودهای زنده، تقویم پخش شمسی، وضعیت سرور و اعلان‌ها.
- **پنل ری‌اکت** فارسی و راست‌به‌چپ، تیره و روشن، مناسب موبایل.
- **حافظه‌های خارجی:** شناسایی و اتصال خودکار، به‌صورت پیش‌فرض فقط‌خواندنی، مرور، مشخصات کامل هر فایل، و روی
  حافظه‌ی قابل نوشتن جابه‌جایی، تغییر نام و حذف؛ کپی فیلم‌ها و قسمت‌ها و فصل‌ها همراه زیرنویس با نمایش درصد، سرعت و
  زمان باقی‌مانده، و جداسازی امن.
- **ورود یکپارچه:** پنل Radarr، Sonarr، Prowlarr، Bazarr، qBittorrent و Jellyfin را برای کسانی که اجازه دارند باز
  می‌کند و ورود خود هر سرویس سر جایش می‌ماند.
- **انتقال از حافظه به سرور:** فیلم‌ها و سریال‌ها تشخیص داده می‌شوند و از طریق خود Radarr و Sonarr با همان نظم آرشیو
  وارد کتابخانه می‌شوند؛ بقیه‌ی فایل‌ها جداگانه ذخیره می‌شوند.
- **لینک دانلود:** یک یا چند فیلم، قسمت یا فصل کامل به صورت ZIP (با امکان ادامه‌ی دانلود) یا RAR، با زمان انقضا یا
  بدون آن، سقف دفعات دانلود و لغو، برای اینترنت و شبکه‌ی داخلی.
- **کاربران و دسترسی‌ها:** فقط شما و افرادی که تعیین می‌کنید، برای مدت مشخص، با مجوز جدا برای هر بخش و هر سرویس.
- **پیکربندی زنده:** دامنه‌ها، پورت‌ها، قابلیت‌ها، ربات، ایندکسرها، منابع زیرنویس و تورنت، بدون ری‌استارت یا با
  تأیید، همراه تاریخچه و بازگشت.
- **مقاوم در برابر قطعی برق:** کارهای ماندگار، نوشتن اتمیک، بررسی سلامت فایل‌ها، جلوگیری از اجرای تکراری و ادامه‌ی
  خودکار بعد از برگشتن برق.
- **قابل انتقال:** یک فایل Docker Compose با پروفایل‌ها، فایل نمونه‌ی `.env` با توضیح همه‌ی متغیرها، اسکریپت نصب و
  مستندات کامل.

### شروع سریع
</div>

```sh
sh install.sh   && $EDITOR .env && sudo make host && docker compose build seemore && docker compose up -d
```

<div dir="rtl">

راهنمای کامل نصب در [docs/installation.md](docs/installation.md) و نکته‌های شبکه‌های فیلترشده در
[docs/iran.md](docs/iran.md) است. مستندات به انگلیسی است و رابط ربات و پنل فارسی است.

**نسخه‌ی ۱٫۱٫۰** ورود یکپارچه، حالت محافظت‌شده‌ی USB و پنل مناسب موبایل را اضافه می‌کند. محدودیت‌های شناخته‌شده در
[CHANGELOG.md](CHANGELOG.md) است.

### مجوز

**فقط برای استفاده‌ی شخصی و غیرتجاری.** seemore تحت مجوز [PolyForm Noncommercial 1.0.0](LICENSE) منتشر شده است:
استفاده، تغییر و اشتراک‌گذاری برای مقاصد شخصی و غیرتجاری آزاد است و هر نوع استفاده‌ی تجاری به مجوز کتبی جداگانه از
صاحب اثر نیاز دارد.

</div>
