# Changelog

All notable changes. Versioning: [SemVer](https://semver.org). A release lists only features that are implemented
**and** tested (see [TESTS.md](TESTS.md)); everything else is under *Known limitations*.

## [1.0.0] — 2026-11-18

First packaged release of seemore: a self-hosted media automation and management platform
(Discovery → Acquisition → Organization → Subtitles → Streaming → Sharing → Archiving) on top of Radarr, Sonarr,
Prowlarr, qBittorrent, Bazarr, Jellyfin and Seerr.

### Added
- **Central core / domain API** — one Node.js core (SQLite, single writer) behind every interface; REST API
  `/api/v1` with domain operations (`/media/requests`, `/storage/exports`, `/storage/imports`, `/shares`, `/jobs`,
  `/settings`, …), OpenAPI 3 spec (98 operations), cookie sessions + CSRF, SSE with `Last-Event-ID` replay.
- **Messenger bot** — Telegram adapter (default) and Bale adapter (optional, `bot.messenger`); persistent main menu,
  search with posters, quality/season selection, requests, library, live downloads, Jalali calendar, recent items,
  server status, notifications (grab, import, failures, health, manual action, subtitles, outages, power-loss
  report). Telegram: long polling or webhook mode with secret token.
- **React panel** (Persian, RTL, dark/light, mobile) with every bot feature plus users, settings, health, jobs.
- **Durable job engine** — `queued → running → verifying → committing → completed` + `paused`,
  `waiting_for_device`, `failed`; `.part` + fsync + sample-hash verification, from-disk re-verification, commit-phase
  deletes, idempotency keys, boot reconciliation, `job_events` (replayable) and a `notifications` outbox.
- **External drives** — host auto-mount with fsck/repair (FAT32, exFAT, NTFS, ext2/3/4, btrfs, xfs), plug/unplug
  notices, browse, metadata of any file, move/rename/mkdir/delete, copy movies/episodes/seasons with subtitles and live
  progress, FAT32 4 GiB check, free-space check, safe eject; device identity by marker + serial + PARTUUID + UUID +
  size.
- **Imports from drives** — scan → classify → identify (names + ffprobe) → match (Radarr/Sonarr lookup, confidence,
  rematch) → dedupe → review → import via Radarr/Sonarr ManualImport; other files to `/data/usb-imports`.
- **Server file browser** with metadata (video, image EXIF, PDF, archives, any file).
- **Share links** — ZIP (streamed, store mode, Range/resume), RAR (background build), single file; expiry, max
  downloads, revoke, hit log, public + LAN URLs, rate limits; from the bot and the panel.
- **Users and permissions** — owner + granted users, 13 permissions, presets, expiry, one-time invites, panel
  accounts, audit log; strangers get no information.
- **Runtime settings** — DB > env > default; change classes hot / reload / recreate / caddy with confirmation,
  history and rollback; domains, ports, feature flags, bot, schedules, indexers (Prowlarr), subtitle providers
  (Bazarr), qBittorrent, *arr root folders, subfa tuning.
- **subfa** — automatic Persian subtitles (Bazarr first, subf2m fallback, retries).
- **Packaging** — one `docker-compose.yml` with profiles (`media`, `subfa`, `proxy`), multi-stage `Dockerfile`
  (panel build + core), `.env.example` documenting every variable, `install.sh` + `Makefile`, `host/install.sh` for the
  udev/systemd helpers (USB auto-mount, seemore-ctl), optional `compose/iran.yml` overlay and mirror build args, docs
  for every component, offline tests (mock Telegram Bot API), CI (lint, tests, compose config, docker build,
  gitleaks).

### Known limitations
- **Real USB plug-in/unplug not tested yet.** Drives were loop-device images; a yank was emulated with lazy unmount +
  loop detach. The copy/import wizards were not run against a physical drive.
- **Telegram adapter tested against a mock Bot API only** (16 unit + 2 integration tests, offline). Not yet run
  against the real `api.telegram.org`; webhook mode not tested with real Telegram. The reference installation runs
  the Bale adapter, which is live-tested.
- **Fresh install of this packaged layout not yet done end-to-end on a clean host.** The compose file is validated
  (`docker compose config`, all profile combinations), the host installer was dry-run, and the image is built in CI;
  the running system was tested in the reference installation's earlier layout (container `media-bot`, separate
  compose projects).
- The `recreate` settings class (ports, memory limit, panel bind) was not exercised live.
- Power-loss tests kill the process (page cache survives); real power loss relies on fsync + from-disk verification +
  fsck before mount.
- Notifications are at-least-once: a crash between sending and recording can repeat one message.
- One transfer job runs at a time.
- A real media request was not placed during tests (flow stopped at the confirm step by design).
- RAR links need the proprietary RARLAB `rar` (downloaded at build time, x64 by default; set `RAR_URL` on ARM).
- A download client whose server dies mid-transfer waits for its TCP timeout before it can resume.
