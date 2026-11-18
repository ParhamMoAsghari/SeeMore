# Backup and restore

## What to back up
| what | where | how often |
|---|---|---|
| seemore DB (jobs, users, grants, links, settings, history, sessions) | `state/seemore/bot.db` | automatic daily copy to `backup.dir` (`/data/backups/seemore/bot-YYYY-MM-DD.db`, `backup.keep_days` = 14) |
| secrets and defaults | `.env` | after every change |
| subfa state / overrides | `state/subfa/` | optional (rebuilt automatically) |
| Caddy certificates | `state/caddy/` | optional (re-issued automatically) |
| service configs | `appdata/` (Radarr, Sonarr, Prowlarr, Bazarr, Jellyfin, qBittorrent, Seerr) | the apps also keep their own scheduled backups in `appdata/<app>/Backups` |
| host helpers | `/etc/seemore/` | after `make host` |
| media | `SEEMORE_DATA` | your choice (large) |

Copy at least `.env`, the latest `bot-*.db`, `appdata/` and `/etc/seemore/` off the host.

The daily backup uses SQLite's online backup (`node:sqlite` backup, or `VACUUM INTO`; consistent while running), writes to a temp file, fsyncs and renames.
Take one now: `make backup` (`docker compose exec seemore node bot.js --backup`).

## Restore
```sh
docker compose stop seemore
cp /data/backups/seemore/bot-2026-01-31.db state/seemore/bot.db
rm -f state/seemore/bot.db-wal state/seemore/bot.db-shm
chown "$SEEMORE_UID:$SEEMORE_GID" state/seemore/bot.db && chmod 600 state/seemore/bot.db
docker compose start seemore
```
On boot jobs are reconciled against the real files (a restored DB that is older than the files is safe: finished
destination files are recognised by size + hash and not copied again). Share links created after the backup are gone.

## Full move / disaster recovery
Install on the new host ([installation.md](installation.md)), put back `.env`, `state/`, `appdata/` and
`/etc/seemore/`, mount the data disk at the same `SEEMORE_DATA` (or change it in `.env` — container paths stay
`/data/...`), then `docker compose up -d`.
