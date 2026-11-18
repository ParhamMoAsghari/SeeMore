#!/usr/bin/env python3
"""Generate app/lib/api/openapi.yaml from the route table in app/lib/api/routes.js.
Every route() line becomes an operation; summaries/params below document the domain semantics.
Run: python3 tools/gen_openapi.py  (no dependencies)."""
import re, json, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / 'app/lib/api/routes.js').read_text()
perm_src = (ROOT / 'app/lib/core.js').read_text() + (ROOT / 'app/lib/core_ext.js').read_text()
perms = dict(re.findall(r"'([a-z_.]+)':\s*\['([a-z_]+)'", perm_src))
version = json.loads((ROOT / 'app/package.json').read_text())['version']

S = {  # "METHOD path": (tag, summary, extra description)
 'GET /media/search': ('media', 'Search movies and series (Radarr/Sonarr lookup). Query: term, kind=all|m|s', ''),
 'GET /media/qualities': ('media', 'Quality options for a request (kind=m|s)', ''),
 'GET /media/request-defaults': ('media', 'Default quality / root folder used for requests', ''),
 'POST /media/requests': ('media', 'Request a movie or series', 'Body: {kind:"m"|"s", key (search result key), quality, mode:"all"|"future"|"seasons", seasons:[n]}. Idempotent: an existing title returns {already:true}. Adds to Radarr/Sonarr and starts the search (domain operation, not a passthrough).'),
 'GET /media/posters/{ref}': ('media', 'Poster image proxied and cached by the API', 'Works even when the client can not reach TMDB/image hosts.'),
 'GET /library': ('library', 'Movies (kind=m) or series (kind=s) in the archive', ''),
 'GET /library/recent': ('library', 'Recently added items', ''),
 'GET /library/files': ('library', 'File-level library (movie folders, series episodes with subtitles) for multi-select', ''),
 'GET /library/movies/{id}': ('library', 'Movie details: file, media info, subtitles', ''),
 'GET /library/series/{id}': ('library', 'Series details: seasons, episodes, files, subtitle status', ''),
 'DELETE /library/{kind}/{id}': ('library', 'Delete a movie/series (query deleteFiles=1 removes files too)', ''),
 'POST /library/{kind}/{id}/search': ('library', 'Trigger a new search for a movie / series / season', 'Body: {season?}'),
 'GET /library/{kind}/{id}/releases': ('library', 'Manual search: list releases', ''),
 'POST /library/{kind}/{id}/grab': ('library', 'Grab one release from a manual search', 'Body: {guid, indexerId}'),
 'GET /calendar': ('library', 'Upcoming episodes and movie releases (days<=60)', ''),
 'GET /downloads': ('downloads', 'Active torrents with progress', ''),
 'POST /downloads/{hash}/pause': ('downloads', 'Pause a torrent', ''),
 'POST /downloads/{hash}/resume': ('downloads', 'Resume a torrent', ''),
 'DELETE /downloads/{hash}': ('downloads', 'Remove a torrent (query blocklist=1 also blocklists the release)', ''),
 'GET /storage/devices': ('storage', 'Connected external drives (identity: fs UUID + device serial + partition + seemore marker)', ''),
 'GET /storage/devices/{id}/entries': ('storage', 'List a folder on a drive (query path)', ''),
 'GET /storage/devices/{id}/metadata': ('storage', 'Metadata of any file/folder on a drive (media streams, image EXIF, PDF, archive listing, text encoding...)', ''),
 'POST /storage/devices/{id}/mkdir': ('storage', 'Create a folder', 'Body: {path, name}'),
 'POST /storage/devices/{id}/rename': ('storage', 'Rename a file or folder', 'Body: {path, name}'),
 'POST /storage/devices/{id}/move': ('storage', 'Move or copy within a drive or to another drive', 'Body: {path, to (drive id), dest, op:"move"|"copy", mode:"ask"|"keep"|"overwrite"}. Returns {conflict} when mode=ask and the name exists; cross-drive operations become a durable job.'),
 'DELETE /storage/devices/{id}/entries': ('storage', 'Delete a file/folder on a drive (query path)', ''),
 'POST /storage/devices/{id}/eject': ('storage', 'Safe eject (sync, unmount, power-off); 409 while a job uses the drive', ''),
 'POST /storage/devices/{id}/mode': ('storage', 'Switch a drive between protected (read-only) and writable', 'Body: {mode:"protected"|"writable", confirm:true} for writable. Policy is stored by drive identity.'),
 'POST /storage/devices/{id}/check': ('storage', 'Check-only filesystem check of a mounted drive', 'Does not repair. A writable drive is briefly remounted read-only for the check.'),
 'POST /storage/devices/{id}/repair': ('storage', 'Repairing filesystem check of a writable drive', 'Refused while the drive is protected. Body: {confirm:true}.'),
 'GET /sso/services': ('sso', 'Services this user may open, with sign-in links', 'Only services matching the user\'s svc.* permissions. Binds an SSO cookie when single sign-on is on and the session does not have one yet.'),
 'GET /sso/oidc/clients': ('sso', 'Registered OpenID Connect clients (owner)', 'Client secrets are not returned.'),
 'PUT /sso/oidc/clients/{id}': ('sso', 'Register or replace an OpenID Connect client (owner)', 'Body: {redirects:[url], perm?}. The client secret is returned once, on creation.'),
 'DELETE /sso/oidc/clients/{id}': ('sso', 'Remove an OpenID Connect client (owner)', ''),
 'POST /storage/exports/plan': ('storage', 'Plan a library -> drive copy (space, FAT32 4 GB limit, already-present files)', 'Body: {drive, sel:{movies:[folder], series:[{name, seasons?, eps?}]}, folder}'),
 'POST /storage/exports': ('storage', 'Start a library -> drive copy job', 'Same body as /plan. Returns the job.'),
 'POST /storage/imports/scans': ('storage', 'Scan a drive folder for import (Scan -> Classify -> Identify -> Match -> Deduplicate)', 'Body: {drive, path}. Returns scanId + movies/series/unknown/other/skipped.'),
 'GET /storage/imports/scans/{id}': ('storage', 'Get a scan result', ''),
 'POST /storage/imports/scans/{id}/rematch': ('storage', 'Change the match of one scanned item', 'Body: {kind:"movie"|"series", index, cand}'),
 'GET /storage/imports/candidates': ('storage', 'Search match candidates (kind, term)', ''),
 'POST /storage/imports': ('storage', 'Confirm a scan and start the import job', 'Body: {scanId, sel:{movies:{i:{on,replace}}, series:{i:{on,replace,eps:{"SxE":false}}}, other, unknownAsOther}}'),
 'GET /files/roots': ('files', 'Server file roots and free space', ''),
 'GET /files/{root}/entries': ('files', 'List a server folder (read-only)', ''),
 'GET /files/{root}/metadata': ('files', 'Metadata of a server file', ''),
 'GET /shares': ('shares', 'Download links (query all=1 for every user, owner only)', ''),
 'POST /shares': ('shares', 'Create a download link', 'Body: {sel | files, kind:"zip"|"rar"|"file", title?, expires? (epoch ms or null), maxDl?}. Response has public and LAN URLs.'),
 'GET /shares/{token}': ('shares', 'Link details + recent downloads', ''),
 'PATCH /shares/{token}': ('shares', 'Change expiry', 'Body: {expires}'),
 'DELETE /shares/{token}': ('shares', 'Revoke a link', ''),
 'GET /jobs': ('jobs', 'Jobs (query active=1, limit)', ''),
 'GET /jobs/{id}': ('jobs', 'Job with live progress (query files=1 for per-file state)', ''),
 'GET /jobs/{id}/events': ('jobs', 'Durable events of one job', ''),
 'POST /jobs/{id}/cancel': ('jobs', 'Cancel a job (partial files are cleaned, healthy files are never touched)', ''),
 'POST /jobs/{id}/resume': ('jobs', 'Resume a paused / waiting job', ''),
 'GET /permissions': ('users', 'Permission keys and presets', ''),
 'GET /users': ('users', 'Granted bot users', ''),
 'POST /users': ('users', 'Grant access', 'Body: {uid, perms:[], expires?, name?}'),
 'GET /users/{uid}': ('users', 'One user + audit', ''),
 'PATCH /users/{uid}': ('users', 'Change perms / expiry / note', ''),
 'POST /users/{uid}/revoke': ('users', 'Revoke access', ''),
 'POST /users/{uid}/extend': ('users', 'Set a new expiry', 'Body: {expires}'),
 'DELETE /users/{uid}': ('users', 'Remove a user (and their panel sessions)', ''),
 'GET /invites': ('users', 'Open invite codes', ''),
 'POST /invites': ('users', 'Create a one-time invite', 'Body: {perms, grantDur?, grantUntil?, ttl}'),
 'DELETE /invites/{code}': ('users', 'Delete an invite', ''),
 'GET /audit': ('users', 'Audit log', ''),
 'GET /panel-accounts': ('users', 'Panel login accounts (no hashes)', ''),
 'PUT /panel-accounts/{username}': ('users', 'Create / reset a panel account for a granted user', 'Body: {uid, password (>=10 chars)}'),
 'DELETE /panel-accounts/{username}': ('users', 'Delete a panel account', ''),
 'POST /auth/password': ('auth', 'Change own panel password', 'Body: {current, next}'),
 'POST /auth/password/shared': ('auth', 'Owner: go back to the shared system password', ''),
 'GET /auth/sessions': ('auth', 'Own active sessions', ''),
 'DELETE /auth/sessions': ('auth', 'Close all other own sessions', ''),
 'GET /settings': ('settings', 'Settings catalog with value, default, validation spec and change class', 'Classes: hot (instant), reload (container restart via socket proxy), recreate (host helper recreates the container with new compose env), caddy (generate + validate + graceful reload).'),
 'PUT /settings': ('settings', 'Apply settings', 'Body: {changes:[{key, value}], confirm}. Disruptive classes without confirm -> 409 {needsConfirm, plan}.'),
 'GET /settings/history': ('settings', 'Change history (old -> new, class, status)', ''),
 'POST /settings/history/{id}/rollback': ('settings', 'Roll back one change', 'Body: {confirm}'),
 'GET /settings/caddy': ('settings', 'Generated Caddy snippet vs. current file', ''),
 'GET /indexers': ('settings', 'Prowlarr indexers with status', ''),
 'GET /indexers/schema': ('settings', 'Indexer definitions available to add (query q)', ''),
 'POST /indexers': ('settings', 'Add an indexer', 'Body: {definitionName, fields:{}, priority?, enable?}'),
 'GET /indexers/{id}': ('settings', 'One indexer (secret fields masked)', ''),
 'PATCH /indexers/{id}': ('settings', 'Enable/disable, priority, fields', ''),
 'POST /indexers/{id}/test': ('settings', 'Test an indexer', ''),
 'DELETE /indexers/{id}': ('settings', 'Remove an indexer', ''),
 'GET /subtitles/providers': ('settings', 'Bazarr subtitle providers (secrets masked)', ''),
 'PUT /subtitles/providers/enabled': ('settings', 'Set the enabled providers', 'Body: {providers:[name]}'),
 'PATCH /subtitles/providers/{name}': ('settings', 'Configure one provider', 'Body: {fields:{}}'),
 'GET /torrent/alt-speed': ('settings', 'qBittorrent alternative speed mode', ''),
 'POST /torrent/alt-speed/toggle': ('settings', 'Toggle alternative speed mode', ''),
 'GET /arr/profiles': ('settings', 'Radarr/Sonarr quality profiles + request quality keys', ''),
 'GET /arr/rootfolders': ('settings', 'Radarr/Sonarr root folders', ''),
 'POST /arr/rootfolders': ('settings', 'Add a root folder (must be under /data/media)', 'Body: {kind, path}'),
 'GET /health': ('system', 'Health: services, process, drives; job recovery and outbox reported separately', 'Unauthenticated callers only get {ok}.'),
 'GET /system/status': ('system', 'Server status (load, memory, disk, indexers, warnings)', ''),
 'GET /system/containers': ('system', 'Containers visible through the restricted Docker proxy', ''),
 'GET /system/containers/{name}/logs': ('system', 'Container logs (secrets redacted, query tail)', ''),
 'POST /system/containers/{name}/restart': ('system', 'Restart an allow-listed container', ''),
 'GET /system/notifications': ('system', 'Bot notification outbox', ''),
 'GET /system/ctl': ('system', 'Host helper status and requests', ''),
}
ops = []
for m in re.finditer(r"^route\('(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)',\s*(call\('([a-z_.]+)')?", src, re.M):
    method, path, _, meth = m.groups()
    oapath = re.sub(r':(\w+)', r'{\1}', path)
    ops.append((method, oapath, perms.get(meth, 'see description') if meth else None))
extra = [
 ('POST', '/auth/login', None, ('auth', 'Log in (public). Body {username, password}. Sets HttpOnly cookie sm_session and returns csrf.', 'Lockout: per user+IP after panel.lock_after failures for panel.lock_minutes; per IP after panel.ip_lock_after failures/hour. 429 with retryAfter.')),
 ('POST', '/auth/logout', None, ('auth', 'Log out', '')),
 ('GET', '/auth/session', None, ('auth', 'Current session: user, perms, feature flags, csrf token', '')),
 ('GET', '/events', None, ('events', 'Server-Sent Events stream', 'Durable job events carry `id: <seq>`; reconnect with Last-Event-ID (or ?after=seq) to replay missed ones. Live events (progress, drives, settings) have no id.')),
 ('GET', '/openapi.yaml', None, ('meta', 'This document (public)', '')),
]
def y(s): return json.dumps(s, ensure_ascii=False)
out = [f"openapi: 3.0.3\ninfo:\n  title: seemore API\n  version: {y(version)}\n  description: {y('Central seemore backend: single source of truth for the Telegram/Bale bots and the web panel. All paths are under /api/v1. Authentication: session cookie sm_session (HttpOnly, SameSite=Strict, Secure on https) + X-CSRF-Token header on every non-GET request (same-origin is also checked). Permissions follow perms.js; x-permission names the permission each operation needs (admin = owner only).')}\nservers:\n  - url: /api/v1\nsecurity:\n  - cookie: []\n    csrf: []\n"]
out.append("components:\n  securitySchemes:\n    cookie: {type: apiKey, in: cookie, name: sm_session}\n    csrf: {type: apiKey, in: header, name: X-CSRF-Token}\n  schemas:\n    Error:\n      type: object\n      properties:\n        error: {type: string}\n        needsConfirm: {type: boolean}\n        plan: {type: array, items: {type: object}}\n  responses:\n    Error:\n      description: Error (400 validation, 401 not logged in, 403 permission/CSRF, 404, 409 confirmation or conflict, 429 rate limit)\n      content:\n        application/json:\n          schema: {$ref: '#/components/schemas/Error'}\n")
paths = {}
for method, p, perm in ops:
    tag, summ, desc = S.get(f'{method} {p}', ('misc', p, ''))
    paths.setdefault(p, []).append((method, tag, summ, desc, perm, False))
for method, p, perm, (tag, summ, desc) in extra:
    paths.setdefault(p, []).append((method, tag, summ, desc, perm, p in ('/auth/login', '/openapi.yaml')))
out.append('paths:\n')
for p in sorted(paths):
    out.append(f'  {p}:\n')
    params = re.findall(r'{(\w+)}', p)
    for method, tag, summ, desc, perm, public in paths[p]:
        out.append(f'    {method.lower()}:\n      tags: [{tag}]\n      summary: {y(summ)}\n')
        if desc: out.append(f'      description: {y(desc)}\n')
        if perm: out.append(f'      x-permission: {perm}\n')
        if public: out.append('      security: []\n')
        if params:
            out.append('      parameters:\n')
            for n in params: out.append(f'        - {{name: {n}, in: path, required: true, schema: {{type: string}}}}\n')
        if method in ('POST', 'PUT', 'PATCH'):
            out.append("      requestBody:\n        required: false\n        content:\n          application/json:\n            schema: {type: object}\n")
        ok = 'text/event-stream' if p == '/events' else 'image/*' if 'posters' in p else 'application/yaml' if p.endswith('.yaml') else 'application/json'
        out.append(f"      responses:\n        '200':\n          description: OK\n          content:\n            {y(ok)}: {{schema: {{type: {'string' if ok != 'application/json' else 'object'}}}}}\n        default: {{$ref: '#/components/responses/Error'}}\n")
(ROOT / 'app/lib/api/openapi.yaml').write_text(''.join(out))
missing = [f'{m} {p}' for m, p, _ in ops if f'{m} {p}' not in S]
print(f'{sum(len(v) for v in paths.values())} operations written; undocumented: {missing}')
