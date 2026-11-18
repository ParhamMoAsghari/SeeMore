# seemore API (`/api/v1`)

Full machine-readable spec: [`app/lib/api/openapi.yaml`](../app/lib/api/openapi.yaml) (also served at
`/api/v1/openapi.yaml`; regenerate with `python3 tools/gen_openapi.py` after changing `routes.js`).

## Auth
* `POST /auth/login {username, password}` → sets cookie `sm_session` (HttpOnly, SameSite=Strict, Secure behind HTTPS)
  and returns `{csrf, uid, perms, features, ...}`. `GET /auth/session` returns the same for an existing cookie.
* Every non-GET request needs header `X-CSRF-Token: <csrf>`; the `Origin`/`Referer` must be the same host.
* Lockout: `panel.lock_after` failures for one user from one IP → locked `panel.lock_minutes`; `panel.ip_lock_after`
  failures from one IP within an hour → IP blocked 1 h. Answer `429 {error, retryAfter}`. Counters persist in SQLite.
* Owner = `PANEL_OWNER_USER`, password = the shared system password (env var named by `PANEL_OWNER_PASS_ENV`).
  Granted bot users can get panel accounts (`PUT /panel-accounts/{username}`); a session dies when the grant expires.
* Permissions: same keys as the bot (`request, library, lib_delete, downloads, server, calendar, notify, usb_view,
  usb_copy, usb_import, usb_manage, files, links`), `admin` = owner. `x-permission` in the spec names each one.

## Conventions
* JSON in/out; errors `{error}` with 400/401/403/404/409/429/5xx. Disruptive settings → `409 {needsConfirm, plan}`;
  resend with `confirm: true`.
* Long operations return a **job** (`/jobs/{id}`), progress arrives over SSE.
* Idempotency: every job gets `idem_key = hash(kind, user, endpoints, files)`; re-submitting the same transfer while it is
  active returns the existing job. Requesting a title that is already in Radarr/Sonarr returns `{already: true}`.

## Events (SSE)
`GET /api/v1/events` (session cookie). Event types: `job` (durable, `id: <seq>`), `progress` (live job counters),
`drives` (drive list changed), `settings` (a setting changed), `hello`. After a reconnect the browser sends
`Last-Event-ID` (or use `?after=<seq>`) and missed durable events are replayed in order.

## Main resources
| area | endpoints |
|---|---|
| media | `GET /media/search`, `GET /media/qualities`, `POST /media/requests`, `GET /media/posters/{ref}` (proxied, cached) |
| library | `GET /library?kind=m|s`, `/library/files`, `/library/movies/{id}`, `/library/series/{id}`, `DELETE /library/{kind}/{id}`, search / releases / grab |
| downloads | `GET /downloads`, pause / resume / `DELETE` |
| storage | `GET /storage/devices`, entries / metadata / mkdir / rename / move / delete / eject, `POST /storage/exports[/plan]`, `POST /storage/imports/scans`, rematch, `POST /storage/imports` |
| files | `GET /files/roots`, `/files/{root}/entries`, `/files/{root}/metadata` (read-only) |
| shares | `GET/POST /shares`, `GET/PATCH/DELETE /shares/{token}` |
| jobs | `GET /jobs`, `/jobs/{id}`, `/jobs/{id}/events`, cancel / resume |
| users | `/users`, `/invites`, `/audit`, `/panel-accounts`, `/permissions`, `/auth/password`, `/auth/sessions` |
| settings | `GET/PUT /settings`, `/settings/history`, rollback, `/settings/caddy`, `/indexers…`, `/subtitles/providers…`, `/torrent/alt-speed`, `/arr/…` |
| system | `GET /health` (services vs. job recovery separately), `/system/status`, `/system/containers[/{name}/logs|restart]`, `/system/notifications`, `/system/ctl` |

Example:
```sh
curl -c jar -H 'Content-Type: application/json' -d '{"username":"admin","password":"…"}' https://panel.example.com/api/v1/auth/login
curl -b jar https://panel.example.com/api/v1/jobs?active=1
curl -b jar -H "X-CSRF-Token: $CSRF" -H 'Origin: https://panel.example.com' -X POST https://panel.example.com/api/v1/jobs/ID/cancel
```
