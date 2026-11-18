# seemore v1.1.0

Single sign-on, write-protected USB, and a responsive panel on the v1.0.0 platform.

Quick start is unchanged: `sh install.sh && $EDITOR .env && sudo make host && docker compose up -d`.
SSO and USB behaviour: [docs/sso.md](docs/sso.md) and [docs/usb-protection.md](docs/usb-protection.md).

### Added
- **Single sign-on.** The panel is the sign-in hub for Radarr, Sonarr, Prowlarr, Bazarr and qBittorrent (Caddy
  forward auth, server-side app login, parent-domain `sm_sso` cookie) and for Jellyfin (OpenID Connect provider in
  the panel, plus the 9p4 `jellyfin-plugin-sso`, one provider per host so LAN users stay on the LAN panel).
  Per-user `svc.*` permissions on the Users page. A **Services** launcher (page, nav entry, dashboard card) lists
  only what the user may open. Every service keeps its native username/password login; a dead or slow panel falls
  back to it.
- OIDC sign-in uses the panel's normal login page (`/login?next=`, same-origin `/oidc/authorize` paths only).
  Settings `sso.enabled`, `sso.public_domain`, `sso.lan_domain`, `sso.oidc`, `sso.oidc_issuer`, `sso.jellyfin_deny`,
  `sso.jellyfin_libraries`, `sso.jellyfin_map`.
- Jellyfin accounts: the first OIDC login creates the user's own non-admin account with an explicit library list.
  SSO never edits existing accounts and never maps a non-owner to an administrator account.
- **USB protection.** Drives mount read-only by default (`usb.default_mode`, `usb.auto_repair`), check-only fsck,
  per-drive policy (`usbpol`), a runtime block-list for formatting tools, write guards in jobs/copy/import, a clear
  message after an unsafe eject, and health notes only when there is a problem.
- **Responsive panel** for phones and tablets (Links, Drives, dashboard, tables, dialogs).
- Settings: `null` resets an override to its env/default value; the panel reset uses it.
- Tests: `sso_e2e.js`, `server/jellyfin_oidc_e2e.py`, `protect.js`, `noformat.js`, `healthmsg.js`.

Upgrade: pull this tag, rebuild the seemore image, and re-run `sudo make host` so `usbpol` and the updated
`usb-automount` units are installed. Existing drives stay on their previous mount until the next plug or an
explicit mode change; unknown drives then mount protected.
