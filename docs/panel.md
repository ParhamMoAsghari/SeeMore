# Web panel (`panel/`)

React 18 + React Router 6, built with Vite 5 into `app/public` and served by the seemore API process (no CDN: the
Vazirmatn variable font is bundled from the `vazirmatn` npm package). **Persian UI, `dir="rtl"`**, dark/light theme
(remembered per browser), responsive with a bottom tab bar on phones. Dates are Jalali via
`Intl.DateTimeFormat('fa-IR-u-ca-persian')`.

## Login
Same username/password as the rest of the system: owner = `PANEL_OWNER_USER`, password = the value of the variable
named by `PANEL_OWNER_PASS_ENV` (default the shared `JELLYFIN_PASS`). Granted users log in only if the owner created a
panel account for them. Sessions, CSRF, lockouts: [security.md](security.md).

## Pages
| page | what |
|---|---|
| داشبورد (Dashboard) | active jobs and downloads, drives, health summary, recent items |
| جست‌وجو (Search) | search movies/series with posters, quality and season choice, request |
| کتابخانه (Library) | movies and series, files, subtitles, re-search, manual release grab, delete |
| دانلودها (Downloads) | live qBittorrent list, pause/resume/remove |
| تقویم (Calendar) | Jalali release calendar |
| حافظه‌ها (Drives) | browse drives, file metadata, move/rename/mkdir/delete, copy wizard, import wizard, eject |
| فایل‌ها (Files) | read-only server file browser (archive, downloads, imports) with metadata |
| لینک‌ها (Links) | create/edit/revoke share links, hits |
| کارها (Jobs) | job list, live progress, events, cancel/resume |
| کاربران (Users) | grants, invites, audit, panel accounts (owner) |
| تنظیمات (Settings) | every runtime setting with its change class, history and rollback; indexers, subtitle providers, qBittorrent, *arr root folders, domains/ports (owner) |
| سلامت (Health) | services vs. job recovery, containers (logs, restart), notification outbox |

Live updates arrive over SSE (`/api/v1/events`); the last event id is kept in `sessionStorage` and replayed after a
reconnect.

## Development
```sh
cd panel && npm ci
SEEMORE_API=http://127.0.0.1:3002 npm run dev   # dev server, proxies /api to a running core
npm run build                                   # production build to ../app/public (the Docker image does this)
```
Code: `src/api.js` (fetch + CSRF), `src/state.jsx` (session, SSE with Last-Event-ID replay, toasts, theme),
`src/ui.jsx` (small UI kit), `src/pages/*` (one file per page), `src/components/*` (JobCard, MediaPicker, MetaView),
`src/pages/settingsMeta.js` (Persian labels and change-class badges of settings).
