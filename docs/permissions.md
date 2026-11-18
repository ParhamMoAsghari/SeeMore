# Users and permissions (`app/lib/perms.js`, `aclui.js`)

The bot answers **only** the owner (`ALLOWED_CHAT`) and users the owner granted access to. Everyone else gets the
short `acl.refusal_text` on `/start` (empty = silent) and no information at all. The same model protects the panel
and the API: permissions are enforced in the core for every client.

## Permissions
| key | allows |
|---|---|
| `request` | search and request downloads |
| `library` | view the library (details, files, subtitles) |
| `lib_delete` | delete from the library |
| `downloads` | downloads list and qBittorrent controls (pause/resume/remove) |
| `server` | server status, indexer health |
| `calendar` | release calendar (Jalali) |
| `notify` | receive media notifications |
| `usb_view` | see external drives and browse them |
| `usb_copy` | copy library items to a drive |
| `usb_import` | import from a drive to the server |
| `usb_manage` | move / rename / delete on drives |
| `files` | browse server files + metadata (read-only) |
| `links` | create download links |
| `svc.jellyfin`, `svc.seerr`, `svc.radarr`, `svc.sonarr`, `svc.prowlarr`, `svc.bazarr`, `svc.qbit` | panel single sign-on into that service (see [sso.md](sso.md)) |

`admin` (users, settings, containers, audit) is the owner only. Presets: **viewer** (library, calendar, notify, `svc.jellyfin`),
**family** (request, library, downloads, calendar, notify, usb_view, usb_copy, links, `svc.jellyfin`, `svc.seerr`), **full** (every permission).
Feature flags (`features.*`) switch an area off for everyone, owner included.

## Grants
* Each user has a set of permissions and an **expiry** (duration, a date, or none); status `active / revoked /
  expired`. A sweep (`schedule.grant_sweep_s`) expires grants and notifies the owner (with an «extend» button) and the
  user once.
* Add by numeric messenger id, or with a **one-time invite** (`/start <code>` or the deep link
  `https://t.me/<bot>?start=<code>`; for Bale `https://ble.ir/<bot>?start=<code>`) with its own validity, the
  permissions and the grant duration that starts at redemption.
* Extend, change permissions, revoke, delete (the audit trail stays).
* Panel accounts: the owner can give a granted user a panel login (`PUT /panel-accounts/{username}`); the session dies
  when the grant expires or is revoked.

## Audit
Every permission-relevant action is written to `audit` (time, user, permission, action, detail); visible per user and
globally in the bot and the panel (Users → Audit), and via `GET /audit`.

## Per-user context
Every request runs inside a context (`ctx.js`) with the caller's chat and user id, so the same handlers serve the
owner and granted users with independent sessions (wizards, pagination) and messages go to the right chat.
