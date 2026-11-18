#!/bin/sh
# seemore bootstrap: prepares this folder and the Docker host for `docker compose up -d`.
#   ./install.sh            create .env (if missing, with random internal secrets), network, directories, permissions
#   ./install.sh --host     additionally install the host components (USB auto-mount + seemore-ctl; needs sudo)
#   ./install.sh --up       additionally build the seemore image and start the stack
# Safe to re-run. Nothing outside this folder is touched except: the docker network, $SEEMORE_DATA sub-folders,
# and (with --host) the files listed in host/install.sh.
set -eu
cd "$(dirname "$0")"
HOST=0; UP=0
for a in "$@"; do case "$a" in --host) HOST=1 ;; --up) UP=1 ;; -h|--help) sed -n '2,8p' "$0"; exit 0 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
command -v docker >/dev/null 2>&1 || { echo "docker is required (https://docs.docker.com/engine/install/)" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "the docker compose plugin (v2.20+) is required" >&2; exit 1; }

if [ ! -f .env ]; then
  say "creating .env from .env.example"
  cp .env.example .env
  rnd() { (openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'); }
  for k in HOOK_KEY INTERNAL_API_KEY SUBFA_HOOK_KEY BOT_WEBHOOK_SECRET; do sed -i "s/^$k=$/$k=$(rnd)/" .env; done
  echo "    edit .env now: TELEGRAM_TOKEN, ALLOWED_CHAT, JELLYFIN_PASS, API keys, domains"
fi
chmod 600 .env
v() { sed -n "s/^$1=//p" .env | tail -1 | tr -d '"'; }
NET=$(v SEEMORE_NETWORK); NET=${NET:-seemore}
UID_=$(v SEEMORE_UID); UID_=${UID_:-1000}; GID_=$(v SEEMORE_GID); GID_=${GID_:-1000}
DATA=$(v SEEMORE_DATA); DATA=${DATA:-/data}
STATE=$(v SEEMORE_STATE_DIR); STATE=${STATE:-./state}
APPD=$(v SEEMORE_APPDATA); APPD=${APPD:-./appdata}
CADDYFILE=$(v CADDYFILE); CADDYFILE=${CADDYFILE:-./config/Caddyfile}

say "docker network $NET"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET"

say "directories"
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
mkdir -p "$STATE/seemore" "$STATE/subfa" "$STATE/caddy-sites" "$STATE/caddy/data" "$STATE/caddy/config" \
  "$APPD/jellyfin" "$APPD/jellyseerr" "$APPD/radarr" "$APPD/sonarr" "$APPD/prowlarr" "$APPD/qbittorrent" "$APPD/bazarr"
[ -f "$STATE/subfa/overrides.json" ] || echo '{}' > "$STATE/subfa/overrides.json"
$SUDO mkdir -p "$DATA/media/movies" "$DATA/media/tv" "$DATA/torrents" "$DATA/usb-imports" "$DATA/backups/seemore"
$SUDO chown "$UID_:$GID_" "$DATA" "$DATA/media" "$DATA/media/movies" "$DATA/media/tv" "$DATA/torrents" "$DATA/usb-imports" "$DATA/backups" "$DATA/backups/seemore"
$SUDO chown -R "$UID_:$GID_" "$STATE/seemore" "$STATE/subfa" "$STATE/caddy-sites" "$APPD"
chmod 700 "$STATE/seemore"
[ -f "$CADDYFILE" ] || { cp config/Caddyfile.example "$CADDYFILE"; echo "    created $CADDYFILE from the example"; }

if [ $HOST = 1 ]; then say "host components"; $SUDO sh host/install.sh --all --dir "$(pwd)"; fi
if [ $UP = 1 ]; then say "build + start"; docker compose build seemore && docker compose up -d && docker compose ps; fi
say "done. Next: docker compose up -d   then open the panel (docs/quickstart in README.md)"
