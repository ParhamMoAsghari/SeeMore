# Settings

Edited in the panel (**Settings**), stored in SQLite (`settings`, precedence DB > env > default) or in the external
service. Every change is validated (type, range, enum, regex, hostnames), written to `settings_history`
(old → new, class, status) and can be rolled back from **Settings → History**.

## Change classes
| class | badge | how it is applied | keys |
|---|---|---|---|
| **hot** | فوری | immediately, no restart | `features.*`, `bot.menu_hidden`, `notify.types`, `links.*`, `panel.*`, `schedule.*`, `requests.*`, `usb.*`, `jobs.*`, `backup.*`, `acl.*`, `jellyfin.*`, `ctl.restartable`; all `qbit.*` (qBittorrent API); Prowlarr indexers (add/enable/disable/priority/test/remove); Bazarr providers (enable/disable/configure); Radarr/Sonarr root folders; torrent alt-speed |
| **reload** | ری‌استارت سرویس | the affected container is restarted through the restricted Docker proxy | `subfa.*` (restart `subfa`, reads `/state/overrides.json`), `bot.messenger`, `bot.token_env`, `bot.update_mode`, `bot.webhook_url`, `bot.webhook_port` (restart seemore itself) |
| **recreate** | ساخت دوباره‌ی کانتینر | `seemore-ctl` updates allow-listed keys in the compose `.env` and runs `docker compose up -d --force-recreate`; on failure the previous `.env` is restored | `net.api_port` (`API_PORT`), `net.links_port` (`DL_PORT`), `container.mem_limit` (`SEEMORE_MEM_LIMIT`), `container.panel_bind` (`SEEMORE_PANEL_BIND`, loopback/private IPs only) |
| **caddy** | بارگذاری Caddy | snippet regenerated → `caddy validate` → graceful `caddy reload`; on failure the previous snippet is restored and the value reverted | `domains.panel_public`, `domains.panel_lan`, `domains.dl_public`, `domains.dl_lan`, `sso.enabled`, `sso.public_domain`, `sso.lan_domain`, `sso.oidc`, `sso.oidc_issuer` (port changes also re-render the snippet) |

Disruptive classes (reload, recreate, caddy) need confirmation: the API answers `409 {needsConfirm, plan}` and the
panel shows what will restart. After a self-recreate the new process settles the history entry on boot
(`applied`, or `reverted` if the helper reported a failure).

Sending `"value": null` removes the override (seemore keys fall back to the env var from `.env`, else the
built-in default; `subfa.*` keys are removed from `overrides.json`). The panel's "بازگشت به پیش‌فرض" does exactly this.
Every change, reset and rollback is recorded in the history and can itself be rolled back.

## Not settable from the panel (by design)
Secrets (bot token, API keys, passwords) stay in `.env`; `bot.token_env` only selects *which* env var holds the token.
SSH, firewall, volumes and images are not touched. Bazarr/Prowlarr secret fields are shown masked (`***`) and only
replaced when you type a new value.

## Feature flags
`features.usb`, `features.usb_import`, `features.usb_manage`, `features.files`, `features.links`,
`features.links_rar`, `features.requests`, `features.notify`, and `subfa.ENABLED` (subf2m fallback). A flag switches the
area off for everyone (bot menu, panel navigation and API).

## Single sign-on and USB protection settings
| key | class | meaning |
|---|---|---|
| `sso.enabled`, `sso.public_domain`, `sso.lan_domain` | caddy | forward-auth blocks and parent-domain cookie (see [sso.md](sso.md)) |
| `sso.oidc`, `sso.oidc_issuer` | caddy | OpenID Connect provider; empty issuer = follow the request host |
| `sso.jellyfin_deny`, `sso.jellyfin_libraries`, `sso.jellyfin_map` | hot | Jellyfin account rules for OIDC sign-in |
| `usb.default_mode`, `usb.auto_repair` | hot | new drives mount `protected` (read-only) by default; auto repair off (see [usb-protection.md](usb-protection.md)) |

## Where each value comes from
1. **Panel / API** (`PUT /settings`) → SQLite `settings` table (survives restarts and upgrades, included in backups).
2. **`.env`** → the environment variable named in the table below (defaults for a fresh install).
3. Built-in default (`app/lib/settings.js`, `DEFS`).

Changes are picked up live (in-process event + a 5 s poll of the table, so a second process writing the same DB is
seen too). `GET /settings` returns every key with value, default, env name, class, description and validation spec;
the panel renders the same catalog with Persian labels (`panel/src/pages/settingsMeta.js`).

## Seemore keys and their environment variables
| key | env | default |
|---|---|---|
| `bot.messenger` | `MESSENGER` | `telegram` (`bale` optional) |
| `bot.token_env` | `BOT_TOKEN_ENV` | `TELEGRAM_TOKEN` |
| `bot.update_mode` | `BOT_UPDATE_MODE` | `polling` (`webhook`) |
| `bot.webhook_url` / `bot.webhook_port` | `BOT_WEBHOOK_URL` / `BOT_WEBHOOK_PORT` | empty / 3003 |
| `domains.panel_public`, `domains.panel_lan` | `PANEL_PUBLIC_HOST`, `PANEL_LAN_HOST` | `panel.example.com`, empty |
| `domains.dl_public`, `domains.dl_lan` | `DL_PUBLIC_HOST`, `DL_LAN_HOST` | `dl.example.com`, empty |
| `sso.enabled`, `sso.public_domain`, `sso.lan_domain` | `SSO_ENABLED`, `SSO_PUBLIC_DOMAIN`, `SSO_LAN_DOMAIN` | off, empty, empty |
| `sso.oidc`, `sso.oidc_issuer` | `SSO_OIDC`, `SSO_OIDC_ISSUER` | off, empty (issuer follows the request host) |
| `sso.jellyfin_deny`, `sso.jellyfin_libraries`, `sso.jellyfin_map` | `SSO_JELLYFIN_DENY`, `SSO_JELLYFIN_LIBRARIES`, `SSO_JELLYFIN_MAP` | empty |
| `usb.default_mode` | `USB_DEFAULT_MODE` | `protected` |
| `links.public_base`, `links.lan_base` | `DL_PUBLIC`, `DL_LAN` | `https://dl.example.com`, empty |
| `net.api_port`, `net.links_port` | `API_PORT`, `DL_PORT` | 3002, 3001 |
| `jellyfin.public_url` | `JELLYFIN_URL` | — |
| `requests.root_m`, `requests.root_s` | `MOVIES_ROOT`, `TV_ROOT` | first root under `/data/media` |
| `backup.dir` | `BACKUP_DIR` | `/data/backups/seemore` |
| `ctl.restartable` | `CTL_RESTARTABLE` | seemore + the stack's containers |

All other keys (`features.*`, `links.*` limits, `panel.*`, `schedule.*`, `jobs.*`, `usb.*`, `acl.*`, `notify.types`,
`bot.menu_hidden`, `requests.quality_*`, `container.*`) have only a built-in default and are changed in the panel.

## Recreate and Caddy classes need the host helper
`recreate` and `caddy` changes are executed by `seemore-ctl` on the host (`sudo make host`). Without it they are
refused with `503 host helper not installed` and nothing changes; apply such values by editing `.env` and running
`docker compose up -d seemore` (domains: then reload Caddy with
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`).
`/etc/seemore/ctl.conf` lists the compose dir, the service, the allowed env keys with their validators and the Caddy
container.

## Changing things that are not settings
Volumes, images, published ports of the media services and the set of profiles are compose-level: edit `.env` and run
`docker compose up -d`. Indexers (Prowlarr), subtitle providers (Bazarr), qBittorrent preferences and Radarr/Sonarr
root folders are edited in the panel through those services' APIs (class `hot`).
