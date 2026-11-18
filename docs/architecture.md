# Architecture

seemore is a **management and automation layer** on top of specialised self-hosted services. It does not
re-implement Radarr, Sonarr, Jellyfin or qBittorrent; it orchestrates them and adds what they do not have: a
messenger bot, a web panel, external-drive transfers, imports from drives, share links, users with fine-grained
permissions, runtime configuration and a durable job engine that survives power loss.

```
 Discovery → Acquisition → Organization → Subtitles → Streaming → Sharing → Archiving
 (search)    (qBittorrent  (Radarr/Sonarr (Bazarr +   (Jellyfin) (ZIP/RAR   (USB copy / import,
              via *arr)     naming)        subfa)                 links)     backups)
```

## One core, many interfaces

```
   Telegram bot ──┐   Bale bot ──┐   React panel (browser) ──┐   curl / scripts ──┐
  (lib/telegram.js)│  (lib/bale.js)│   cookie session + CSRF   │                   │
                   ▼              ▼           SSE ▲            ▼                   ▼
          bot UI (handlers.js, *ui.js)      REST /api/v1 (lib/api: routes, auth, sse, openapi.yaml)
                   │                                      │
                   └──────────────► core.call(uid, method, params) ◄────────────────┘
                                  permission check (perms.js) + per-user context (ctx.js)
                                                   │
     domain services: svc/usbops · svc/selection · svc/library · media · importer · links · files · meta · usb
     engines:         jobs (durable job engine) · outbox (notifications) · settings · config/apply (change classes)
                                                   │
     adapters: Radarr · Sonarr · Prowlarr · qBittorrent · Bazarr · Jellyfin · docker-proxy · seemore-ctl · usb-automount
                                                   │
                         SQLite  state/seemore/bot.db  (WAL, synchronous=FULL)
```

* **The core is the source of truth.** One process (container `seemore`) owns the SQLite database, the job engine
  and the outbox, so there is exactly one writer. Bot, panel and API are thin clients: they translate user input
  into `core.call(uid, method, params)` and render results. Permissions, audit log and job state are therefore the
  same in every interface.
* **Domain API, not a proxy.** The HTTP API exposes seemore operations — `POST /api/v1/media/requests`,
  `POST /api/v1/storage/imports`, `POST /api/v1/storage/exports`, `POST /api/v1/shares`, `GET /api/v1/jobs` — never
  raw Radarr/Sonarr/qBittorrent endpoints. Which *arr calls sit behind an operation is an internal detail of the core,
  so a service can be replaced without touching any client. See [api.md](api.md).
* **Interface independence over process independence.** The core runs in one Node.js process (simple, one DB
  writer); what is kept strictly separate is the *code boundary*: interfaces never import service clients directly.
* **Ports inside the container:** `3000` webhooks from Radarr/Sonarr, internal RPC and internal SSE (docker network
  only, `INTERNAL_API_KEY`); `3001` download links; `3002` API + panel; `3003` Telegram webhook receiver (webhook mode
  only). Caddy terminates TLS and proxies the panel and link domains.

## Job engine

Every long transfer (`to_usb` copy to a drive, `usb_copy`/`usb_move` copy or move on or between drives, `import` from a drive) is a **job** row in
SQLite, created in the same transaction as its file manifest (RAR builds for share links have their own durable
status in the `links` table, see [shares.md](shares.md)). See [job-engine.md](job-engine.md).

```
 queued ──► running ──► verifying ──► committing ──► completed
    ▲          │  ▲          │             │
    │          ▼  │          ▼             ▼
    │      paused │       failed        failed
    └── waiting_for_device (drive gone; resumes only on the *same* drive)
```

* **Atomic file writes:** data goes to `<name>.part`, is fsynced, checked (size + sample hash), renamed, and the
  directory is fsynced. Before `completed`, every destination file is re-verified from disk.
* **Commit phase:** sources of a move are deleted, imports are handed to Radarr/Sonarr, and staging is cleaned only
  in `committing`, i.e. only after the destination is verified.
* **Idempotency:** each job has `idem_key = hash(kind, user, endpoints, files)`. Re-submitting an active job returns
  the existing one; a file already at the destination with identical size + hash is not copied again; imports store
  the Radarr/Sonarr command id and on recovery check the real *arr file records before importing again.
* **Recovery:** on boot, interrupted jobs are reconciled (`recovery = {at, from, phase, action}`), orphan `.part` files
  removed and the last finished file re-verified before continuing. See [recovery.md](recovery.md).

## State, events and notifications (three tables)

| table | holds | used for |
|---|---|---|
| `jobs` (+ `job_files`) | current state, phase, attempts, `idem_key`, recovery info, per-file manifest | resuming work |
| `job_events` | append-only history with a monotonic `seq` | SSE replay, audit, debugging |
| `notifications` | outbox rows `pending → sent / failed`, attempts, backoff, unique `dedupe` key | at-least-once delivery to messengers |

Producers write the event and the outbox row in the same transaction as the state change; a worker sends
notifications with backoff (5 s·2ⁿ, max 30 min, 12 tries). If the bot or the panel is disconnected during a transfer,
nothing is lost: the panel reconnects to `GET /api/v1/events` with `Last-Event-ID` (or `?after=<seq>`) and receives
the missed durable events in order; the bot's outbox drains when the messenger is reachable again.

## Device identity

A drive is identified by a combination, never by the filesystem UUID alone (UUIDs can be missing, duplicated by
cloning, or change on reformat):

* a seemore marker file `.seemore/id` written on writable drives,
* udev serial / model / vendor, partition `PARTUUID`, filesystem UUID, size and filesystem type.

A job in `waiting_for_device` resumes only on a strong match (marker equal, or ≥ 2 strong fields and no mismatch);
a writable drive that lacks the job's marker is treated as a different drive and is never written to. Tested with a
cloned image that had the same label, volume id and size (TESTS.md, T5).

## Settings

`settings.js` (SQLite table `settings`, precedence **DB > environment > built-in default**) plus external scopes
(subfa overrides, qBittorrent preferences, Prowlarr indexers, Bazarr providers, *arr root folders). Every key has a
**change class** — `hot`, `reload`, `recreate`, `caddy` — and the panel shows it before you save. Disruptive classes
need confirmation, every change is recorded with rollback. See [settings.md](settings.md).

## Host boundary

The container never gets the raw Docker socket or root:

* **seemore-docker-proxy** — restricted Docker API (list/inspect, logs, restart) on an internal network.
* **seemore-ctl** — host systemd path unit; runs only allow-listed actions: recreate the seemore container with
  validated env keys, validate + reload Caddy. See [settings.md](settings.md) and [security.md](security.md).
* **usb-automount** — host udev + systemd helper: fsck/repair, mount, drive JSON, safe eject. See [usb.md](usb.md).

## Repository map

| path | component | docs |
|---|---|---|
| `app/bot.js` | core process entry (starts DB, settings, engines, servers, bot) | this file |
| `app/lib/core.js`, `core_ext.js` | domain methods `[permission, fn]` | [api.md](api.md) |
| `app/lib/api/` | REST API, auth, SSE, OpenAPI spec | [api.md](api.md) |
| `app/lib/jobs.js` | durable job engine | [job-engine.md](job-engine.md) |
| `app/lib/importer.js`, `importui.js` | import pipeline | [imports.md](imports.md) |
| `app/lib/usb.js`, `usbui.js`, `svc/usbops.js` | drives, transfers, drive file manager | [usb.md](usb.md) |
| `app/lib/links.js`, `linksui.js` | share links, ZIP streaming, RAR | [shares.md](shares.md) |
| `app/lib/perms.js`, `aclui.js` | users, grants, invites, audit | [permissions.md](permissions.md) |
| `app/lib/settings.js`, `config/*` | runtime settings, change classes, Caddy, host helper client | [settings.md](settings.md) |
| `app/lib/messenger.js`, `telegram.js`, `bale.js` | messenger adapters | [bot-telegram.md](bot-telegram.md), [bot-bale.md](bot-bale.md) |
| `app/lib/handlers.js`, `views.js`, `*ui.js` | bot menus and flows | [bot-telegram.md](bot-telegram.md) |
| `app/lib/outbox.js`, `notify.js` | notifications, *arr webhooks, watchers | [recovery.md](recovery.md) |
| `panel/` | React panel (Persian, RTL) | [panel.md](panel.md) |
| `subfa/` | Persian subtitles service | [subfa.md](subfa.md) |
| `host/` | udev/systemd helpers + installer | [usb.md](usb.md), [installation.md](installation.md) |
| `docker-compose.yml`, `Dockerfile`, `.env.example` | deployment | [installation.md](installation.md) |
