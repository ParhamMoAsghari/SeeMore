# seemore — tests

Every scenario records four things: **(a) the state before the failure**, **(b) how the system behaved while
recovering**, **(c) the final state of the data**, and **PASS/FAIL**.

**Common acceptance criterion (every test):** no failed operation may cause loss of a healthy file, a partial
file in the final archive, a duplicate execution, or a false success status.

The v1.0.0 scenarios below were implemented and run on the reference installation. v1.1.0 adds live-stack
scripts for single sign-on and USB protection (`app/tests/sso_e2e.js`, `app/tests/server/jellyfin_oidc_e2e.py`,
`app/tests/protect.js`, `app/tests/healthmsg.js`, `app/tests/server/healthmsg.sh`). `node app/tests/noformat.js`
passes offline and is safe to run anywhere; the other new scripts need the running stack. What is not covered
is listed under *Known limitations* in [CHANGELOG.md](CHANGELOG.md).

| suite | where it ran | how to run | result |
|---|---|---|---|
| Stage 1: failure & recovery (T1–T8) | reference installation (real Radarr/Sonarr/Jellyfin, loop-device drives) | `app/tests/reference/` (needs the run's harness) | 8/8 PASS |
| Stage 2: API + panel end-to-end | reference installation | `app/tests/reference/panel_e2e.py` | 94/94 PASS |
| Telegram adapter (unit) | offline, mock Bot API | `cd app && node --test 'tests/unit/*.test.js'` | 16/16 PASS |
| Core process with Telegram (integration) | offline, mock Bot API | `cd app && node --test 'tests/integration/*.test.js'` | 2/2 PASS |
| Packaging | CI / box | lint, compose config, host installer dry-run, secret scan | see below |

The reference installation runs the Bale messenger; the Telegram adapter is tested against a mock only.

Run on the reference installation (Ubuntu, Docker) on **2026-11-18**, against the real Radarr/Sonarr/Jellyfin stack,
with loop-device "drives" (FAT32 `SMTA`, NTFS `SMTB`, and a *different* FAT32 image `C` cloned to have the
same label `SMTA`, the same volume id `5A5A-0001` and the same size). Tests use a throwaway worker container
(`tests/worker.js`: real job engine, importer, outbox and link server, own SQLite DB, messenger stand-in that
records every message to `sent.jsonl` — no messenger traffic). Faults:

* **Power loss** = `docker kill -s KILL` of the worker from the host, or `SM_CRASH_AT=<hook>`, which makes the
  process SIGKILL itself at an exact point (`before_rename`, `verify_file`, `commit_start`, `after_import_cmd`).
  Hooks are inert unless `SM_TEST_HOOKS=1` (never set in production). The page cache survives a process kill,
  so this proves the *logic* (state machine, idempotency, recovery); it can not reproduce kernel-level loss of
  unflushed data — that is covered by fsync + the from-disk verify phase + fsck before mount.
* **Drive yank** = lazy unmount + loop detach (`umount -l; losetup -d`) mid-file.
* Scripts: `app/tests/reference/` (`worker.js`, `ctl.js`, `arrcheck.js`, `cleanup.js`, drivers `t7.sh`, `t8.sh`,
  `common.sh`, `cleanup.sh`, `panel_e2e.py`). They need the throwaway harness of the reference run (loop images,
  `lib.sh`) and are kept as a record of the procedure, not as a turnkey suite.

| # | Scenario | Result |
|---|---|---|
| T1 | Power loss during **copy** (to USB, FAT32) | PASS |
| T2 | Power loss during **Verifying** | PASS |
| T3 | Power loss after `.part` written+fsynced, **before rename** | PASS |
| T4 | Power loss during **Committing** of a cross-drive move (sources already deleted) | PASS |
| T5 | Drive **yanked** mid-file → a **different** drive with same label/UUID/size → the **same** drive | PASS |
| T6 | **Concurrent** jobs / duplicate request / file ops on a path in use | PASS |
| T6b | (found while testing) destination full (ENOSPC) | PASS |
| T7 | Import from USB; **Radarr/Sonarr response lost after a successful import** (crash right after the command completed, twice: movie, then series) | PASS |
| T8 | **Restart with active job + unsent notifications + download in progress + RAR being built** | see below |

---
## Stage 1 — failure & recovery scenarios (job engine, drives, imports, links)

### T1 — power loss during copy
* **(a) before:** job `to_usb` 4 files (3×40 MB + `.fa.srt`) → FAT32 `SMTA`, state `running/copy`; `file1.bin` done,
  `file2.bin.part` 16 MB on the drive, file2 `copying`, others `pending`. `docker kill -s KILL`.
* **(b) recovery:** boot reconcile recorded `recovery={from: running, phase: copy, action: requeue}`; deleted the
  orphan `.part`, re-verified the last finished file, requeued → events `queued → running → verifying → committing → completed`, attempts=2.
* **(c) final:** 4 files, all `done` + `verified`; sha256 identical to the sources; 0 `.part`; no duplicates
  (`file1 (1).bin` etc. absent); outbox delivered `boot resumed=1` and exactly one `job_end … done`.
* **PASS**

### T2 — power loss in Verifying (`SM_CRASH_AT=verify_file`)
* **(a)** DB: `running/verifying`, phase `verify`, all 4 files `done` but **not** `verified`.
* **(b)** boot: `recovery={from: verifying, phase: verify, action: requeue}`; copy loop had nothing to do (files on disk
  matched size+sample hash), verify ran again from disk → committing → completed, attempts 2.
* **(c)** all 4 verified, sha256 = source, 0 partials, one `job_end`. **PASS**

### T3 — power loss between fsync of `.part` and rename (`SM_CRASH_AT=before_rename`)
* **(a)** file1 `verifying` (its `.part` complete on disk), the rest pending; job `running/copy`.
* **(b)** reconcile removed the `.part`, reset file1 to `pending`, recopied → verify → commit → completed (attempt 2).
* **(c)** sha256 = source for all 4, 0 partials, nothing duplicated. **PASS**

### T4 — power loss in Committing of a cross-drive **move** FAT32→NTFS (`SM_CRASH_AT=commit_start`, after the source files were deleted)
* **(a)** `running/committing`; destination files done+verified on NTFS; sources on FAT32 already removed.
* **(b)** boot: `recovery={from: committing, phase: commit}`; resumed in commit phase, re-verified destination from disk,
  source deletion re-run idempotently (ENOENT = already done) → completed.
* **(c)** destination sha256 = original data, 0 partials; source folder gone (it was a move); no data lost at any point
  because sources are deleted only after the destination is verified. **PASS**

### T5 — drive yank, wrong drive, same drive
* **(a)** copy to `SMTA` running, `file1.bin.part` being written. Drive yanked.
* **(b)** within one chunk the engine saw the drive gone → `waiting_for_device` (err `gone`), notice `job_waiting` queued.
  Attached **C** (same label `SMTA`, same FAT volume id, same size, but no seemore marker): the job **stayed waiting**,
  nothing was written to C (C remained empty). Detached C, re-attached the original image: the host fsck ran (`clean`),
  identity matched via the `.seemore/id` marker → `job_resumed` → orphan `.part` removed → completed (attempt 2).
* **(c)** sha256 = source for all 4 files, 0 partials, C untouched, notices `job_waiting`, `job_resumed`, `job_end` once each. **PASS**

### T6 — concurrency on the same files/paths
* Same request submitted twice → **the same job id** (idempotency key on kind+user+endpoints+files).
* A second, overlapping job (2 of the same files, same destination) queued while the first ran; while running:
  `usb.rename`, `usb.delete`, `usb.move` on the busy folder → `path busy`; `usb.eject` → `a transfer is using this drive`;
  moving a folder into its own subfolder → refused.
* Final: first job completed (4 verified files); the second completed in <1 s by recognising identical files already at
  the destination (size+sample hash) — **no second copy, no `file (1)` duplicates**; sha256 = source. **PASS**
* **T6b ENOSPC** (drive filled by earlier tests): both jobs → `failed` with `nospace`, the half-written `.part` was
  removed, no partial file left, no false success. **PASS**

### T7 — import from USB (NTFS) + *arr response lost after a successful import
Drive content: movie folder (`.mkv` + `.fa.srt` + `.en.srt` + `Sample/sample-*.mkv`), `Sherlock/Season 1/Sherlock.S01E01…mkv`
(+`.fa.srt`), odd naming `Sherlock/فصل ۱/قسمت 2.mkv`, `<Series>.S02E01…mkv` of a series already in the library, `Docs/notes.txt`, `Photos/سفر/pic.jpg`.
* Scan pipeline (`scan → classify → identify(ffprobe) → match → dedupe`): movie matched (conf high), Sherlock S1E1+E2
  (the Persian folder name parsed), the library series' 2x1 flagged **dup** (skipped by default), sample skipped, 2 other files.
* **(a) crash #1:** process killed right after Radarr's ManualImport command completed, before the bot recorded it
  (= response lost): movie group `importing`, `importCmd` persisted. **crash #2** (restart, same hook): movie
  recovered, Sherlock's ManualImport completed, process killed again before recording.
* **(b) recovery:** each time the engine waited on the saved command id, then checked Radarr `moviefile` / Sonarr
  `episodefile` for a file of the same size → found → treated as imported, removed the staged copy, **did not import again**;
  subtitles placed, Bazarr scan + Jellyfin refresh triggered; completed at attempt 3.
* **(c) final:** Radarr: 1 movie file, **1** import event; Sonarr Sherlock: 2 episode files, 2 import events; the existing
  series unchanged (10 files); subtitles next to videos with language tags; other files in `/data/usb-imports/SMTB/2026-11-18/…`
  with relative paths; staging empty; source drive untouched (10 files). **PASS**
* Bug found & fixed during this test: Radarr ignores `folder` when `movieId` is passed to `/manualimport`, which pushed
  movies to the fallback path, and a rescan racing Radarr's automatic refresh after "add" recorded the same file
  twice. Fix: query manual import by folder only, and `settle()` (wait for running Refresh/Rescan of that item)
  before importing or rescanning. Re-run above is with the fix.

### T8 — restart with an active job, unsent notifications, a download in progress and a RAR being built
* **(a) before:** to_usb job `running/copy`; messenger "down" (every send fails) → 2 notices `pending` (attempts 2–3,
  `network down`); a ZIP link (movie + 2 episodes, 23.4 MB) being downloaded at 150 KB/s (1.5 MB received); a RAR link of a
  2.1 GB file with `building.rar` at 684 MB. `docker kill -s KILL` of the worker.
* **(b) recovery:** client connection dropped (2 MB received). Restart with the messenger back: boot requeued the job
  (`recovery={from: running, phase: copy}`), outbox delivered the pending notices, the RAR build restarted from scratch
  (the half-built `building.rar` is never served), the download resumed with `curl -C -` (HTTP Range).
* **(c) final:** job completed, 4 files verified, sha256 = source, 0 `.part`; resumed ZIP is valid (`testzip()` = None) and
  every member's sha256 equals the library file; RAR `ready`, `rar t` OK, no leftover `building.rar`; outbox: 43 sent,
  0 pending/failed; exactly **one** `job_end` for the job. **PASS**

### Production checks
* Live container: `docker kill -s KILL` of the core container → note Docker does **not** apply `restart: always` after an explicit
  `docker kill` (by design); after a real power cut the daemon is enabled at boot (`systemctl is-enabled docker` =
  enabled) and restarts all 11 containers (all `restart=always`). Started it manually: healthy in 35 s, DB intact.
* Radarr/Sonarr/Bazarr/Prowlarr/Seerr SQLite run in WAL; qBittorrent keeps fastresume files — resume-data save interval
  lowered from 60 to 5 minutes.

### Known limits (not part of v1.0.0 guarantees)
* Process-kill tests keep the page cache; true power loss is covered by fsync + from-disk verify + fsck before mount, but
  the verify read may be served from cache in the same boot.
* A drive yank is emulated with lazy unmount + loop detach; real USB disconnects show as I/O errors (classified the same way).
* A client whose server dies mid-download waits for its TCP timeout before resuming.
* Notifications are at-least-once. One job runs at a time.

All test items were removed afterwards (Radarr movie, Sonarr series and episode file, imported "other" files, test
links/cache, loop images); Jellyfin rescanned. Leftover: one Sonarr *history* row for a test import into an existing library series
(file deleted; later removed from the Sonarr database by hand).

---

## Stage 2 — API + web panel end-to-end (reference installation, 2026-11-18)

Automated: `sudo python3 app/tests/reference/panel_e2e.py` on the server (reads the owner password from `.env`, never prints it;
triggers no download, no indexer search, no media request; every change is rolled back; temporary users are removed).
Last full run: **94/94 PASS** in 79 s.

| Area | What was tested | Result |
|---|---|---|
| Login | owner wrong password → 401; correct → 200; cookie `HttpOnly; SameSite=Strict; Secure` (https) | PASS |
| CSRF | POST without `X-CSRF-Token` → 403; foreign `Origin` → 403; no session → 401 | PASS |
| Lockout | test account: 4×401 then 5th → 429; correct password refused while locked (retryAfter 900 s) | PASS |
| Permissions | temp user (uid 999000001, perms `[library]`, 1 h) + panel account: 200 on library/jobs; 403 on downloads, users, settings, storage, files, shares, containers, indexers, audit and on POST shares / DELETE library / PUT settings / POST users / POST requests; revoking the grant → session 401; user, panel account and lockout rows removed | PASS |
| Pages (owner) | 33 GET endpoints behind every panel page (health, library, files, calendar, downloads, drives, server files, shares, jobs, users, invites, audit, panel accounts, sessions, settings, history, caddy, indexers, subtitles, alt-speed, arr profiles/root folders, system status/containers/notifications/ctl, qualities, request defaults) | PASS |
| Health vs recovery | `/health` returns services (6/6 ok) and job recovery as separate sections | PASS |
| Library | movie detail (with Bazarr subtitles) and series detail (4 seasons) | PASS |
| Metadata | ffprobe metadata of a real video on the server (h264, 1040p, 1 audio) | PASS |
| Search / request | Radarr metadata lookup (8 results); poster proxied + cached; request validation (no key → 400). Request flow stops at the confirm step | PASS |
| Downloads | pause + resume of one existing torrent | PASS |
| Docker proxy / logs | 11 containers visible via the restricted socket proxy; logs endpoint returns lines with no secrets (bot token/arr/qbit/Jellyfin values checked) | PASS |
| Share links | ZIP link from a library selection (1 h, max 3) → public page 200 + LAN page 200 → change expiry → detail with hits → revoke → 410 | PASS |
| Settings hot | `links.rate_per_min` 90→91 applied instantly; invalid value → 400; rollback from history → 90; reset (`value: null`) → override removed, env/default value | PASS |
| Settings reload | `subfa.SUBF2M_GAP=9` without confirm → 409 + plan; confirmed → overrides.json written, subfa restarted via socket proxy (log "gap 9.0s"); rollback → "gap 8.0s"; override removed (`{}`), subfa running | PASS |
| Settings caddy | `domains.panel_lan` → `panel-e2e.home.lan` (seemore-ctl validate + reload, new host 200); rollback → `panel.home.lan` 200; reset to the env value (override removed) 200; invalid hostname → 400 | PASS |
| SSE replay | 3 durable events written while disconnected; reconnect with `Last-Event-ID` → exactly those 3 ids, in order, then `hello.lastSeq` = last id; reconnect at latest id → nothing replayed (synthetic job removed afterwards) | PASS |
| Domains | public `https://panel.example.com` and LAN `http://panel.home.lan` (owner login + API; hostnames anonymized here) | PASS |
| Logout | session invalid afterwards | PASS |

Browser smoke (headless Chrome from outside, temporary all-permissions non-owner account, removed afterwards):
14 desktop pages + 4 mobile pages render with live data, no page errors, no error banners (only console entry: the
expected 401 of the pre-login session check). Non-owner is redirected away from Users/Settings. Load 1.5–5 s from
outside (network latency; the app answers in ~40 ms locally).

Bot regression (`docker exec <core container> node bot.js --selftest`, read-only, Bale): all steps OK (search, captions, poster,
qualities, library, downloads, calendar, recent, server, lib card, Jellyfin link). The lib-card step used a hard-coded
Radarr id 1 that no longer exists; it now uses the first library movie.

Bugs found and fixed by this run: (1) invalid setting values returned 500 instead of 400 (settings.js validation errors
are now user errors); (2) seemore keys could not be reset — `value: null` now drops the DB override (env/default
again), and the panel's "بازگشت به پیش‌فرض" sends null instead of the built-in default.
After the run the settings table has no overrides and subfa `overrides.json` is `{}`, as before the deploy.

The then-current whole-stack compose was validated with `docker compose config` (12 services).

Not covered (limits): export/import wizards against a real drive (no USB drive attached during the run; the drive
engine itself is covered by T1–T8 above); a real media request (stops at confirm by design); the `recreate`
settings class was not exercised live (it recreates the core container itself).

## Packaging (v1.0.0 repository layout, 2026-11-18)

(a) before: code from the reference installation, Bale messenger, several compose projects; (b) packaged into this
repository and re-tested offline; (c) the reference installation was not modified.

| Check | Result |
|---|---|
| **Telegram adapter unit tests** (`app/tests/unit/telegram.test.js`, `bale.test.js`) against `tests/mock-telegram.js`: messenger factory (Telegram default, Bale selectable); getMe → username + `t.me` deep link; sendMessage to the owner outside a request and to the granted user inside one, reply keyboard made persistent (`is_persistent`); text over 4000 chars trimmed; editMessageText with "message is not modified" ignored; answerCallbackQuery (text, alert); sendPhoto by upload and file_id, later edit uses editMessageCaption; sendChatAction with numeric chat id; setMyCommands drops commands Telegram rejects; getUpdates long poll with offset/allowed_updates; 429 honours `retry_after`; 4xx not retried and no token in errors; network failure marked and token redacted; webhook: setWebhook with secret, getWebhookInfo, receiver `/healthz` 200, missing/wrong secret 401, wrong path 404, bad JSON 400, getUpdates 409 while a webhook is set, non-https URL rejected, deleteWebhook; Bale: base URL override, `ble.ir` link, string chat id | 16/16 PASS |
| **Integration, polling** (`app/tests/integration/telegram-bot.test.js`): real `bot.js` process on a temp data dir against the mock. getMe, deleteWebhook, setMyCommands at start; owner `/start` → main menu with persistent keyboard; a stranger gets only the refusal; a callback is answered; an update older than the stored offset is ignored; the token never appears in the log | PASS |
| **Integration, webhook** (`BOT_UPDATE_MODE=webhook`): setWebhook called with the secret and the URL; wrong secret → 401 and no handling; valid update → main menu; duplicate update id → handled once | PASS |
| Lint: `node --check` on every JS file, `py_compile` (subfa, seemore-ctl, panel_e2e), `bash -n` on every shell script, OpenAPI regenerated = committed (98 operations) | PASS |
| `docker compose config` (compose v2.32.4) with `.env.example`: no profile → `seemore`, `docker-proxy`; `media` → +8 services; `subfa`, `proxy`; all → 12 services; `compose/iran.yml` overlay merges | PASS |
| `host/install.sh --all --dry-run`: templates filled (`__UID__`, `__GID__`, `__USB_BASE__`, `__SEEMORE_DIR__`, `__CADDY_CONTAINER__`), no placeholder left, units + udev rule + `/etc/seemore/usb.conf` planned | PASS |
| Panel production build (Vite) | PASS |
| Docker image build + smoke test | in CI (`docker-build` job; no Docker on the packaging box) |
| Secret scan (gitleaks, full history + tree, plus pattern scan for owner ids, IPs, private domains, personal names/emails) | see the release report: no findings |

Not covered: the real Telegram Bot API (no bot token was used during packaging); a fresh end-to-end install of this
layout on a clean host.
