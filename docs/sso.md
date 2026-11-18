# Single sign-on (SSO)

The panel is the sign-in hub for the media services. **Every service keeps its own username/password login**: SSO only adds a faster path
and never replaces or weakens the native one. If the panel is down, the services' own login pages keep working.

Persian version: [sso.fa.md](sso.fa.md).

## Concepts
- **Permissions** `svc.radarr`, `svc.sonarr`, `svc.prowlarr`, `svc.bazarr`, `svc.qbit`, `svc.jellyfin`, `svc.seerr` (Users page, "ورود به ..." checkboxes).
  The owner has all of them. The family preset also gets Jellyfin and Seerr, the viewer preset only Jellyfin.
- **Services page** (`/services`, plus a card at the top of the dashboard) lists only the services the signed-in user may open.
- **SSO cookie** `sm_sso`: a separate random token (stored hashed, bound to the panel session), `Domain=<parent domain>`, `HttpOnly`, `SameSite=Lax`,
  `Secure` on HTTPS. It dies with the panel session (logout, expiry, revocation). The panel's own `sm_session` cookie stays host-only and `SameSite=Strict`.

## Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent (forward auth)
Caddy blocks are generated into `seemore-sso.caddy` next to `seemore.caddy` from the `sso.*` settings. With a valid `sm_sso` cookie and the right
permission, the panel logs in to the app **on the server** with the shared admin account and hands the browser a normal app session cookie.
No API key or password reaches the browser. Without the cookie or the permission, or if the panel is down or slow (2 s dial / 5 s header timeout),
the request goes straight to the app's own login. A loop guard and a 120 s pause after a failed relay prevent hammering.
Because these apps have a single account each, **granting one of these permissions gives that user admin access to that app**.

Entry URL: `https://<service>.<public domain>/?smsso=1` (or the LAN equivalent over HTTP).

Settings (all `caddy` class, applied with validation and rollback): `sso.enabled`, `sso.public_domain`, `sso.lan_domain`.
Replace the static service blocks of your Caddyfile with the generated ones (keep `import /etc/caddy/seemore/*.caddy`).

## Jellyfin and Seerr
- **Owner one-click**: `https://jellyfin.<domain>/__sso` signs the owner in with the configured Jellyfin account. Seerr likewise (owner only).
- **Everyone else, Jellyfin: OpenID Connect** through the [9p4 `jellyfin-plugin-sso`](https://github.com/9p4/jellyfin-plugin-sso). Native
  password login, Quick Connect and the TV/phone apps are untouched; the apps keep using password or Quick Connect.

### OIDC setup (Jellyfin)
1. Install the plugin release that matches your Jellyfin (v4.0.0.4 loads on Jellyfin 10.11 and later), verify its published SHA-256, put it in
   `<jellyfin config>/data/plugins/SSO Authentication_<version>/` and restart Jellyfin once.
2. Turn the provider on in the panel: `sso.oidc = true`. Leave `sso.oidc_issuer` empty so the issuer follows the host the user came from
   (`https://panel.<public domain>` or `http://panel.<lan domain>`), because the SSO cookie is per parent domain.
3. Register a client (owner only): `PUT /api/v1/sso/oidc/clients/seemore-jellyfin` with
   `{"redirects":["https://jellyfin.<public>/sso/OID/redirect/seemore","http://jellyfin.<lan>/sso/OID/redirect/seemore-lan"],"perm":"svc.jellyfin"}`.
   The secret is returned once.
4. Add two plugin providers with that client id and secret (`POST /sso/OID/Add/<name>` as a Jellyfin admin):
   `seemore` with `OidEndpoint=https://panel.<public>` and `seemore-lan` with `OidEndpoint=http://panel.<lan>` and `DisableHttps=true`.
   Use `Enabled=true`, `EnableAuthorization=false`, `NewPath=true`, `DefaultUsernameClaim=preferred_username`. Keep the plugin file private (`chmod 600`).
5. Let Jellyfin trust the proxy so redirect URIs use `https` on the public host: in `network.xml` set `KnownProxies` to your proxy container name.
6. Put the button on the login page: Dashboard > Branding > Login disclaimer:
   `<form action="/__oidc" method="get"><button type="submit" class="raised block emby-button button-submit">Sign in with SeeMore</button></form>`.
   The generated Caddy blocks redirect `/__oidc` to the provider that matches the host (`seemore` or `seemore-lan`).

The sign-in page is the panel's normal login (`/login?next=<authorize URL>`; `next` must be a same-origin `/oidc/authorize?...` path).

### Account mapping rules
- The owner signs in as the owner's own Jellyfin account (same username).
- A panel user with `svc.jellyfin` gets **their own** Jellyfin account, created on first login (random password, not admin, explicit library list
  `sso.jellyfin_libraries`, empty = every library not restricted to a denied account). Existing accounts are never modified by SSO.
- A non-owner can never land in a Jellyfin administrator account or in a name listed in `sso.jellyfin_deny`. Any error means deny.
- `sso.jellyfin_map` (`panelname=jellyfinname`, comma separated, exact case) maps a panel user to one **existing** non-admin Jellyfin account, even if
  that name is in the deny list; nothing is created or changed. Nobody else can reach it.

Settings: `sso.oidc`, `sso.oidc_issuer`, `sso.jellyfin_deny`, `sso.jellyfin_libraries`, `sso.jellyfin_map` (the last three are hot).

## Rollback
Set `sso.enabled=false` (the generated blocks fall back to plain proxies) and `sso.oidc=false`; remove `seemore-sso.caddy` and reload Caddy;
disable or uninstall the plugin and restart Jellyfin. Nothing in the services' own configuration was changed by SSO.

## Tests
`app/tests/sso_e2e.js` (run inside the container; forward-auth, launcher filtering, per-service native/SSO/no-permission/no-cookie cases, OIDC flow) and
`app/tests/server/jellyfin_oidc_e2e.py` (real Jellyfin plugin flow on both domains, account rules, native login). Use temporary users only.
