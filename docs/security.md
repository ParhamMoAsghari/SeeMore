# Security

* **Who can use it**: the bot (Telegram or Bale) answers only the owner (`ALLOWED_CHAT`) and users granted in Users (with expiry and
  per-feature permissions). Panel login: owner with the shared system password; granted users only if the owner
  created a panel account for them. Permissions are enforced in the core (`perms.js`) for every client.
* **Passwords**: never stored in clear; scrypt (N=32768). The owner hash is derived from the env secret at start and
  re-derived when it changes (an HMAC fingerprint, not the secret, is stored). Jellyfin is never called with guesses.
* **Sessions**: 256-bit random id, only its sha256 stored; cookie HttpOnly + SameSite=Strict (+ Secure over HTTPS);
  sliding expiry `panel.session_hours`; password change closes other sessions; revoking a grant kills its sessions.
* **CSRF**: per-session token header on every mutating request + same-origin check. **Brute force**: per user+IP and
  per-IP lockout persisted in SQLite; ~0.5 s delay on failures; uniform work for unknown users.
* **Headers**: strict CSP (no inline scripts, no third-party origins; the Vazirmatn font is bundled), `X-Frame-Options`
  deny, `nosniff`, `Referrer-Policy`, HSTS on HTTPS. Client IP is taken from `X-Forwarded-For` only when the peer is a
  private address (Caddy).
* **Docker**: no raw socket in the app. `seemore-docker-proxy` exposes only container list/inspect, logs and restart,
  on an internal network reachable only by `seemore`; restart/log targets are additionally allow-listed
  (`ctl.restartable`). Note: container inspect can include other containers' env — the app only reads whitelisted keys
  and the proxy is not reachable from anything else.
* **Host helper**: `seemore-ctl` executes only `recreate` (allow-listed env keys with per-key validators, fixed compose
  dir) and `caddy-reload`; request files are opened with `O_NOFOLLOW`, size-limited, id-checked.
* **Paths**: every drive/server path is resolved and checked against its root (no `..`, no escaping symlinks for
  links); server files are read-only in the panel; library deletes go through Radarr/Sonarr.
* **Share links**: 128-bit tokens, expiry and max-downloads, per-IP rate limit, parallel-download cap, invalid-token
  IP block, revocation, hit log.
* **Secrets in logs**: container logs shown in the panel are redacted (tokens, keys, passwords, bearer headers).
* **Bot webhook** (Telegram webhook mode): every update must carry `X-Telegram-Bot-Api-Secret-Token`
  (`BOT_WEBHOOK_SECRET`), only the configured path is accepted, bodies are limited to 1 MiB, duplicate update ids are
  dropped.
* **Published ports**: Docker-published ports bypass host firewalls such as ufw. Admin UIs (Radarr, Sonarr, Prowlarr,
  qBittorrent, Bazarr, FlareSolverr) and the panel bind to `127.0.0.1` by default; `container.panel_bind` accepts only
  loopback/private addresses. Expose things through Caddy instead.
* **Least privilege**: the seemore and subfa containers run as `SEEMORE_UID:SEEMORE_GID`, not root; the docker proxy
  is read-only with a tmpfs; the host helpers accept only fixed actions; the API never executes shell commands with
  user input.
* **Secrets**: only in `.env` (mode 600, git-ignored). The panel can choose *which* variable holds the bot token but
  never reads or stores the token itself. The repository and its history are scanned with gitleaks in CI
  (`.gitleaks.toml`).
* **Not changed by seemore**: SSH, firewall rules, other compose projects.

## Reporting a vulnerability
Open a private security advisory on the repository (or contact the owner directly); do not file public issues for
security problems.
