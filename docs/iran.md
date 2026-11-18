# Running where services are filtered (Iran)

seemore was built and is used in Iran. None of the workarounds below are on by default; enable what you need.

## TMDB is filtered
* Radarr and Sonarr use their own metadata proxies (`radarr.servarr.com`, `skyhook.sonarr.tv`), so search, requests
  and imports work without TMDB. seemore never calls TMDB directly (imports identify titles through Radarr/Sonarr).
* Jellyfin calls TMDB for metadata and waits for timeouts. The overlay `compose/iran.yml` resolves the TMDB hosts to
  `127.0.0.1` inside the Jellyfin container so those calls fail fast:
  ```
  COMPOSE_FILE=docker-compose.yml:compose/iran.yml     # in .env
  ```
* Posters in the bot and the panel are fetched through an image proxy (`wsrv.nl`) and cached.

## Docker Hub / Alpine / npm are blocked
* **Registry mirror for Docker Hub images** (the `node` base image): either configure the daemon
  (`/etc/docker/daemon.json` → `{"registry-mirrors": ["https://<mirror>"]}`, restart Docker) or set
  `NODE_IMAGE=<mirror>/library/node:22-alpine` in `.env`.
* The media images come from `lscr.io` and `ghcr.io`; if those are blocked too, override `*_IMAGE` variables with a
  mirror.
* **Alpine packages:** `ALPINE_MIRROR=http://<alpine mirror>` (build arg, replaces `dl-cdn.alpinelinux.org`).
* **npm (panel build):** `NPM_REGISTRY=https://<npm mirror>`.
* **RAR:** `WITH_RAR=0` if rarlab.com is unreachable (RAR share links then fail; ZIP links are unaffected), or set
  `RAR_URL` to a reachable copy of the same tarball.

## Telegram is filtered
Use the Bale adapter (`MESSENGER=bale`, see [bot-bale.md](bot-bale.md)), or point `TELEGRAM_API_BASE` at a reachable
Bot API endpoint (self-hosted `telegram-bot-api` abroad, or a reverse proxy you control), see
[bot-telegram.md](bot-telegram.md).

## Power cuts
Frequent outages are the reason for the durable job engine and the recovery design: see [recovery.md](recovery.md).
Enable the Docker daemon at boot (`systemctl enable docker`) and keep the data disk's filesystem journaled (ext4/xfs).
Lowering qBittorrent's resume-data save interval (qBittorrent → Options → Advanced) means fewer torrents re-check
after a cut; the reference install uses 5 minutes.
