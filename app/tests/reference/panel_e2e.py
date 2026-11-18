#!/usr/bin/env python3
"""seemore panel/API end-to-end test against the live stack (run on the server as root).
No new downloads or indexer searches are triggered; every change is rolled back; the test user is removed.
Secrets are read from the compose .env and never printed."""
import urllib.parse, json, os, re, ssl, subprocess, sys, time, secrets, urllib.request, urllib.error, http.cookiejar, socket

D = os.environ.get('SEEMORE_DIR', '/opt/seemore')
C = os.environ.get('SEEMORE_CONTAINER', 'seemore')
SUBFA_OV = os.environ.get('SUBFA_OVERRIDES_HOST', f'{D}/state/subfa/overrides.json')
ENV = dict(l.split('=', 1) for l in open(f'{D}/.env').read().splitlines() if '=' in l and not l.startswith('#'))
CFG = dict(l.split('=', 1) for l in open(f'{D}/config.env' if os.path.exists(f'{D}/config.env') else f'{D}/.env').read().splitlines() if '=' in l and not l.startswith('#'))
OWNER, OWNER_PW = CFG.get('PANEL_OWNER_USER', 'admin'), ENV[CFG.get('PANEL_OWNER_PASS_ENV', 'JELLYFIN_PASS')]
PUB = 'https://' + CFG['PANEL_PUBLIC_HOST']; LAN_HOST = CFG['PANEL_LAN_HOST']
RES = []
def rec(name, ok, info=''):
    RES.append((name, ok, info)); print(('PASS ' if ok else 'FAIL ') + name + (f' — {info}' if info else ''), flush=True)

class Client:
    """base = public https URL, or http://127.0.0.1 with a Host header (LAN domain through Caddy)."""
    def __init__(self, base, host=None):
        self.base, self.host = base, host; self.jar = http.cookiejar.CookieJar(); self.csrf = ''; self.last_headers = {}
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.origin = f'http://{host}' if host else base
    def req(self, method, path, body=None, csrf=True, origin=None, raw=False, timeout=60, headers=None):
        url = self.base + ('/api/v1' + path if path.startswith('/') else path)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method)
        if self.host: r.add_header('Host', self.host)
        if data is not None: r.add_header('Content-Type', 'application/json')
        if method != 'GET':
            r.add_header('Origin', origin or self.origin)
            if csrf: r.add_header('X-CSRF-Token', self.csrf)
        for k, v in (headers or {}).items(): r.add_header(k, v)
        try:
            with self.op.open(r, timeout=timeout) as resp:
                self.last_headers = dict(resp.headers); b = resp.read()
                return resp.status, (b if raw else (json.loads(b) if b and b[:1] in b'[{"' else b.decode(errors='replace')))
        except urllib.error.HTTPError as e:
            b = e.read(); self.last_headers = dict(e.headers)
            try: return e.code, json.loads(b)
            except Exception: return e.code, b.decode(errors='replace')
    def login(self, u, p):
        s, j = self.req('POST', '/auth/login', {'username': u, 'password': p}, csrf=False)
        if s == 200: self.csrf = j['csrf']
        return s, j

def sh(cmd): return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()
DBQ_JS = ("const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/state/bot.db');d.exec('PRAGMA busy_timeout=5000');"
          "const s=process.argv[1];console.log(JSON.stringify(/^\\s*select/i.test(s)?d.prepare(s).all():d.prepare(s).run()))")
def dbq(sql):
    return subprocess.run(['docker', 'exec', C, 'node', '-e', DBQ_JS, sql], capture_output=True, text=True).stdout.strip()

def main():
    t0 = time.time()
    # ---------------- auth ----------------
    o = Client(PUB)
    s, j = o.login(OWNER, OWNER_PW + 'x'); rec('login: owner wrong password → 401', s == 401, f'status {s}')
    s, j = o.login(OWNER, OWNER_PW); rec('login: owner correct password → 200', s == 200 and j.get('owner') is True, f'status {s}')
    ck = o.last_headers.get('Set-Cookie', '')
    rec('session cookie HttpOnly + SameSite=Strict + Secure (https)', all(x in ck for x in ('HttpOnly', 'SameSite=Strict', 'Secure')), ck.split(';', 1)[1].strip() if ';' in ck else ck[:20])
    s, _ = o.req('POST', '/jobs/nope/cancel', {}, csrf=False); rec('CSRF: POST without token → 403', s == 403, f'status {s}')
    s, _ = o.req('POST', '/jobs/nope/cancel', {}, origin='https://evil.example'); rec('CSRF: foreign Origin → 403', s == 403, f'status {s}')
    s, _ = Client(PUB).req('GET', '/users'); rec('no session → 401', s == 401, f'status {s}')

    # ---------------- owner read flows (every page) ----------------
    pages = {}
    for p in ['/auth/session', '/health', '/library?kind=m', '/library?kind=s', '/library/recent', '/library/files', '/calendar?days=14',
              '/downloads', '/storage/devices', '/files/roots', '/files/media/entries', '/shares?all=1', '/jobs?limit=50', '/permissions',
              '/users', '/invites', '/audit?limit=20', '/panel-accounts', '/auth/sessions', '/settings', '/settings/history', '/settings/caddy',
              '/indexers', '/subtitles/providers', '/torrent/alt-speed', '/arr/profiles', '/arr/rootfolders', '/system/status',
              '/system/containers', '/system/notifications?limit=5', '/system/ctl', '/media/qualities?kind=m', '/media/request-defaults']:
        s, j = o.req('GET', p, timeout=90); pages[p] = j
        rec(f'GET {p}', s == 200, f'status {s}' + (f' {str(j)[:120]}' if s != 200 else ''))
    h = pages['/health']
    rec('health: services listed separately from job recovery', isinstance(h, dict) and h.get('services') and 'recovery' in h,
        ', '.join(f"{x['name']}={'ok' if x['ok'] else 'DOWN'}" for x in (h.get('services') or [])))
    cat = pages['/settings']; rec('settings catalog has seemore + subfa + qbit scopes with classes', isinstance(cat, list) and {e.get('scope') for e in cat} >= {'seemore', 'subfa', 'qbit'} and {e.get('cls') for e in cat} >= {'hot', 'reload', 'recreate', 'caddy'}, f'{len(cat)} settings')
    cad = pages['/settings/caddy']; rec('Caddy snippet on disk == rendered from settings', isinstance(cad, dict) and cad.get('current') == cad.get('rendered'))
    rec('docker proxy: containers visible', isinstance(pages['/system/containers'], list) and len(pages['/system/containers']) >= 8, f"{len(pages['/system/containers'])} containers")
    s, lg = o.req('GET', f'/system/containers/{C}/logs?tail=200')
    tok = ENV.get(ENV.get('BOT_TOKEN_ENV', 'TELEGRAM_TOKEN'), '') or ENV.get('BALE_TOKEN', '')
    rec('logs endpoint works and redacts secrets', s == 200 and isinstance(lg, list) and not any(tok and tok in l for l in lg) and not any(ENV.get(k, 'zz-none') in l for k in ('RADARR_KEY', 'SONARR_KEY', 'QBIT_PASS', 'JELLYFIN_PASS') for l in lg), f'{len(lg) if isinstance(lg, list) else lg} lines')
    # library details
    movies = pages['/library?kind=m'] if isinstance(pages['/library?kind=m'], list) else (pages['/library?kind=m'] or {}).get('items', [])
    series = pages['/library?kind=s'] if isinstance(pages['/library?kind=s'], list) else (pages['/library?kind=s'] or {}).get('items', [])
    mv = movies[0] if movies else None
    if mv:
        s, j = o.req('GET', f"/library/movies/{mv['libId']}"); rec('library: movie detail (file, media info, subtitles)', s == 200 and 'file' in j, f"{mv.get('title')} subs={len((j or {}).get('subs', []) if isinstance(j, dict) else [])}")
    if series:
        s, j = o.req('GET', f"/library/series/{series[0]['libId']}"); rec('library: series detail (seasons/episodes/subtitle status)', s == 200 and j.get('seasons') is not None, f"{series[0].get('title')} seasons={len(j.get('seasons', [])) if isinstance(j, dict) else '?'}")
    # files metadata
    def first_file(root, rel='', depth=0):
        s, ents = o.req('GET', f'/files/{root}/entries?path=' + urllib.request.quote(rel))
        if s != 200 or depth > 4: return None
        for e in ents:
            if not e['dir'] and re.search(r'\.(mkv|mp4|avi)$', e['name'], re.I): return (rel + '/' if rel else '') + e['name']
        for e in ents:
            if e['dir']:
                r = first_file(root, (rel + '/' if rel else '') + e['name'], depth + 1)
                if r: return r
    f = first_file('media')
    if f:
        s, m = o.req('GET', '/files/media/metadata?path=' + urllib.request.quote(f), timeout=90)
        rec('files: video metadata (ffprobe streams)', s == 200 and (m.get('media') or {}).get('video'), f"{os.path.basename(f)}: {((m.get('media') or {}).get('video') or [{}])[0].get('codec')} {((m.get('media') or {}).get('video') or [{}])[0].get('height')}p, audio {len((m.get('media') or {}).get('audio', []))}")
    # search + poster proxy, request flow up to the confirm step (no add, no indexer search)
    s, r = o.req('GET', '/media/search?term=' + urllib.request.quote('The Pianist') + '&kind=m', timeout=90)
    items = (r or {}).get('items', []) if isinstance(r, dict) else []
    rec('search (Radarr metadata lookup only)', s == 200 and len(items) > 0, f'{len(items)} results')
    if movies:
        s, b = o.req('GET', f"/media/posters/{movies[0]['ref']}", raw=True, timeout=60)
        rec('poster proxied + cached through the API', s == 200 and len(b) > 1000, f'{len(b) if s == 200 else s} bytes')
    s, j = o.req('POST', '/media/requests', {'kind': 'm'}); rec('request: validation (missing key → 400, nothing added)', s == 400, f'status {s}')
    # downloads pause/resume (only if a torrent exists that is not paused)
    dl = pages['/downloads']; ditems = (dl or {}).get('items', []) if isinstance(dl, dict) else []
    act = next((x for x in ditems if 'paus' not in str(x.get('state', '')).lower() and 'stop' not in str(x.get('state', '')).lower()), None)
    if act:
        hsh = act.get('hash')
        s1, _ = o.req('POST', f'/downloads/{hsh}/pause', {}); time.sleep(3); s2, _ = o.req('POST', f'/downloads/{hsh}/resume', {})
        rec('downloads: pause + resume one torrent', s1 == 200 and s2 == 200, f"{act.get('name', '')[:50]}")
    else: rec('downloads: pause + resume', True, f'skipped — {len(ditems)} torrents, none active')
    # ---------------- shares ----------------
    lib = pages['/library/files']
    small = sorted((lib or {}).get('m', []), key=lambda x: x['size'])[:1]
    if small:
        s, l = o.req('POST', '/shares', {'sel': {'movies': [small[0]['name']]}, 'kind': 'zip', 'title': 'seemore e2e test', 'expires': int(time.time() * 1000) + 3600000, 'maxDl': 3})
        ok = s == 201 and l.get('token'); rec('shares: create ZIP link from a library selection (1h, max 3)', bool(ok), f"status {s}")
        if ok:
            tkn = l['token']; urls = l['urls']
            pub = urllib.request.urlopen(urllib.request.Request(urls['page'], method='GET'), timeout=30).status
            lan = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--resolve', f"{urllib.parse.urlsplit(urls['pageLan']).hostname}:80:127.0.0.1", urls['pageLan']], capture_output=True, text=True).stdout
            rec('shares: public + LAN link pages served', pub == 200 and lan == '200', f'public {pub}, lan {lan}')
            s, _ = o.req('PATCH', f'/shares/{tkn}', {'expires': int(time.time() * 1000) + 7200000}); rec('shares: change expiry', s == 200)
            s, d = o.req('GET', f'/shares/{tkn}'); rec('shares: detail + hit stats', s == 200 and 'hits' in d, f"{len(d.get('hits', []))} hits")
            s, _ = o.req('DELETE', f'/shares/{tkn}'); time.sleep(1)
            code = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', urls['public']], capture_output=True, text=True).stdout
            rec('shares: revoke → link stops working', s == 200 and code in ('404', '410'), f'after revoke: {code}')
    # ---------------- settings: hot, reload (subfa) with rollback, 409 confirm, caddy with rollback ----------------
    def val(key):
        _, c = o.req('GET', '/settings'); return next((e['value'] for e in c if e['key'] == key), None)
    old = val('links.rate_per_min')
    s, r = o.req('PUT', '/settings', {'changes': [{'key': 'links.rate_per_min', 'value': old + 1}]})
    rec('settings hot: links.rate_per_min applied instantly', s == 200 and val('links.rate_per_min') == old + 1, f'{old} → {old + 1}')
    hid = r['applied'][0]['history'] if s == 200 else None
    s, _ = o.req('PUT', '/settings', {'changes': [{'key': 'links.rate_per_min', 'value': 'abc'}]}); rec('settings validation: bad value → 400', s == 400, f'status {s}')
    if hid:
        s, _ = o.req('POST', f'/settings/history/{hid}/rollback', {}); rec('settings hot: rollback from history', s == 200 and val('links.rate_per_min') == old, f'back to {val("links.rate_per_min")}')
    def overridden(key):
        _, c = o.req('GET', '/settings'); return next((e.get('overridden') for e in c if e['key'] == key), None)
    s, _ = o.req('PUT', '/settings', {'changes': [{'key': 'links.rate_per_min', 'value': None}]})
    rec('settings reset (value null) → override removed, env/default value', s == 200 and overridden('links.rate_per_min') is False and val('links.rate_per_min') == old, f'value {val("links.rate_per_min")}, overridden {overridden("links.rate_per_min")}')
    gap = val('subfa.SUBF2M_GAP')
    s, r = o.req('PUT', '/settings', {'changes': [{'key': 'subfa.SUBF2M_GAP', 'value': 9}]})
    rec('settings reload class without confirm → 409 needsConfirm + plan', s == 409 and r.get('needsConfirm') and r['plan'][0]['cls'] == 'reload', f"plan {r.get('plan') if isinstance(r, dict) else r}")
    s, r = o.req('POST', '/settings', None) if False else o.req('PUT', '/settings', {'changes': [{'key': 'subfa.SUBF2M_GAP', 'value': 9}], 'confirm': True}, timeout=120)
    ok = s == 200 and any(a.get('type') == 'restart' and a.get('ok') for a in r.get('actions', []))
    time.sleep(8)
    ov = sh(f'cat {SUBFA_OV} 2>/dev/null'); lgs = sh('docker logs --since 40s subfa 2>&1 | grep "subfa started" | tail -1')
    rec('settings reload class: subfa.SUBF2M_GAP=9 → overrides.json + subfa restarted via socket proxy', ok and '"SUBF2M_GAP"' in ov and 'gap 9.0s' in lgs, f'overrides {ov}; log: {lgs[-70:]}')
    hid = r['applied'][0]['history'] if s == 200 else None
    if hid:
        s, r = o.req('POST', f'/settings/history/{hid}/rollback', {'confirm': True}, timeout=120); time.sleep(8)
        lgs = sh('docker logs --since 40s subfa 2>&1 | grep "subfa started" | tail -1')
        rec('settings reload class: rollback → gap back, subfa restarted', s == 200 and f'gap {float(gap):.1f}s' in lgs, f'log: {lgs[-70:]}')
        s, r = o.req('PUT', '/settings', {'changes': [{'key': 'subfa.SUBF2M_GAP', 'value': None}], 'confirm': True}, timeout=120); time.sleep(8)
        ov = sh(f'cat {SUBFA_OV} 2>/dev/null')
        health = sh("docker inspect -f '{{.State.Status}}' subfa")
        rec('subfa back to env defaults (override removed), running', ov.strip() in ('{}', '') and health == 'running', f'overrides {ov or "-"}; {health}')
    lan_old = val('domains.panel_lan'); tmp_host = 'panel-e2e.' + lan_old.split('.', 1)[1]
    s, r = o.req('PUT', '/settings', {'changes': [{'key': 'domains.panel_lan', 'value': tmp_host}], 'confirm': True}, timeout=150)
    code = sh(f"curl -s -o /dev/null -w '%{{http_code}}' --resolve {tmp_host}:80:127.0.0.1 http://{tmp_host}/healthz")
    rec('settings caddy class: domains.panel_lan → new host, Caddy validated + reloaded by seemore-ctl', s == 200 and all(a.get('ok') for a in r.get('actions', [])) and code == '200', f'{tmp_host} → {code}')
    hid = r['applied'][0]['history'] if s == 200 else None
    if hid:
        s, r = o.req('POST', f'/settings/history/{hid}/rollback', {'confirm': True}, timeout=150)
        code = sh(f"curl -s -o /dev/null -w '%{{http_code}}' --resolve {lan_old}:80:127.0.0.1 http://{lan_old}/healthz")
        rec('settings caddy class: rollback → original LAN domain served again', s == 200 and code == '200' and val('domains.panel_lan') == lan_old, f'{lan_old} → {code}')
        s, r = o.req('PUT', '/settings', {'changes': [{'key': 'domains.panel_lan', 'value': None}], 'confirm': True}, timeout=150)
        code = sh(f"curl -s -o /dev/null -w '%{{http_code}}' --resolve {lan_old}:80:127.0.0.1 http://{lan_old}/healthz")
        rec('settings caddy class: reset to config.env value (override removed)', s == 200 and overridden('domains.panel_lan') is False and val('domains.panel_lan') == lan_old and code == '200', f'{val("domains.panel_lan")} → {code}')
    s, r = o.req('PUT', '/settings', {'changes': [{'key': 'domains.panel_lan', 'value': 'bad host!'}], 'confirm': True})
    rec('settings caddy class: invalid hostname rejected', s == 400, f'status {s}')
    # ---------------- SSE replay ----------------
    def sse(after, secs=6):
        r = urllib.request.Request(PUB + '/api/v1/events', headers={'Last-Event-ID': str(after), 'Accept': 'text/event-stream'})
        buf = b''
        try:
            with o.op.open(r, timeout=secs + 2) as resp:
                t1 = time.time()
                while time.time() - t1 < secs and b'event: hello' not in buf:
                    chunk = resp.read1(4096)
                    if not chunk: break
                    buf += chunk
        except (socket.timeout, TimeoutError): pass
        txt = buf.decode(errors='replace'); m = re.search(r'event: hello\ndata: (\{.*\})', txt)
        return [int(x) for x in re.findall(r'^id: (\d+)', txt, re.M)], (json.loads(m.group(1)) if m else None), txt
    _, hello0, _ = sse(10**12)          # first connection: current position
    last = None
    if hello0:
        _, h1, _ = sse(0); last = h1['lastSeq'] if h1 else None
    # while "disconnected", 3 durable events are written for a synthetic, already-finished job (no work is done)
    jid = 'e2e' + secrets.token_hex(3); now = int(time.time() * 1000)
    dbq(f"INSERT INTO jobs(id,kind,status,uid,title,data,created,updated,idem_key,phase,attempts) VALUES('{jid}','e2e','canceled',NULL,'e2e sse test','{{}}',{now},{now},'{jid}','copy',0)")
    for st in ('queued', 'running', 'canceled'):
        dbq(f"INSERT INTO job_events(job_id,t,type,state,data) VALUES('{jid}',{now},'status','{st}','{{\"e2e\":1}}')")
    ids, hello, txt = sse(last)
    want_n = 3
    jobs_seen = re.findall(r'"job":"(\w+)"', txt)
    rec('SSE: reconnect with Last-Event-ID replays exactly the missed durable events, then hello', last is not None and len(ids) == want_n and ids == list(range(ids[0], ids[0] + 3)) and ids[0] > last and set(jobs_seen) == {jid} and hello and hello['lastSeq'] == ids[-1],
        f'Last-Event-ID {last} → replayed ids {ids}, hello.lastSeq {hello and hello["lastSeq"]}')
    ids2, hello2, _ = sse(ids[-1] if ids else 0); rec('SSE: reconnect at the latest id replays nothing', ids2 == [] and hello2 is not None, f'{ids2}')
    ids3, _, _ = sse(0) if False else (None, None, None)
    dbq(f"DELETE FROM job_events WHERE job_id='{jid}'"); dbq(f"DELETE FROM jobs WHERE id='{jid}'")
    # ---------------- restricted test user ----------------
    TUID, TUSER, TPW = 999000001, 'e2e-restricted', secrets.token_urlsafe(16)
    s, _ = o.req('POST', '/users', {'uid': TUID, 'name': 'e2e test (temporary)', 'perms': ['library'], 'expires': int(time.time() * 1000) + 3600000})
    s2, _ = o.req('PUT', f'/panel-accounts/{TUSER}', {'uid': TUID, 'password': TPW})
    rec('users: grant restricted user (library only, 1h) + panel account', s == 201 and s2 == 200, f'{s}/{s2}')
    u = Client(PUB); s, j = u.login(TUSER, TPW)
    rec('restricted user can log in; perms = [library]', s == 200 and j.get('perms') == ['library'] and not j.get('owner'), f"perms {j.get('perms') if isinstance(j, dict) else j}")
    for p, want in [('/library?kind=m', 200), ('/jobs', 200), ('/downloads', 403), ('/users', 403), ('/settings', 403), ('/storage/devices', 403), ('/files/roots', 403), ('/shares', 403), ('/system/containers', 403), ('/indexers', 403), ('/audit', 403)]:
        s, _ = u.req('GET', p); rec(f'perm: restricted GET {p} → {want}', s == want, f'status {s}')
    for m, p, b in [('POST', '/shares', {'sel': {'movies': ['x']}}), ('DELETE', '/library/m/999999', None), ('PUT', '/settings', {'changes': [{'key': 'links.rate_per_min', 'value': 1}]}), ('POST', '/users', {'uid': 5, 'perms': []}), ('POST', '/media/requests', {'kind': 'm', 'key': 'x'})]:
        s, _ = u.req(m, p, b); rec(f'perm: restricted {m} {p} → 403', s == 403, f'status {s}')
    s, _ = o.req('POST', f'/users/{TUID}/revoke', {}); s2, _ = u.req('GET', '/library?kind=m')
    rec('revoking the grant kills the restricted session', s == 200 and s2 == 401, f'after revoke: {s2}')
    o.req('POST', '/users', {'uid': TUID, 'name': 'e2e test (temporary)', 'perms': ['library'], 'expires': int(time.time() * 1000) + 3600000})
    # lockout (on the test account, never on the owner)
    codes = [Client(PUB).login(TUSER, 'wrong-password-' + str(i))[0] for i in range(5)]
    s, j = Client(PUB).login(TUSER, TPW)
    rec('lockout: 5 wrong passwords → locked; correct password refused while locked (429)', codes[:4] == [401] * 4 and codes[4] == 429 and s == 429, f'codes {codes} then correct → {s} retryAfter {j.get("retryAfter") if isinstance(j, dict) else ""}s')
    # LAN domain
    lanc = Client('http://127.0.0.1', LAN_HOST); s, j = lanc.login(OWNER, OWNER_PW)
    s2, idx = lanc.req('GET', '/', raw=True) if False else (None, None)
    s3, _ = lanc.req('GET', '/library?kind=s')
    page = subprocess.run(['curl', '-s', '--resolve', f'{LAN_HOST}:80:127.0.0.1', f'http://{LAN_HOST}/'], capture_output=True, text=True).stdout
    ck = lanc.last_headers
    rec('LAN domain (http): panel page + owner login + API', s == 200 and s3 == 200 and 'id="root"' in page, f'login {s}, api {s3}')
    pubpage = urllib.request.urlopen(PUB + '/', timeout=30).read().decode()
    rec('public domain (https): panel page served', 'id="root"' in pubpage and 'dir="rtl"' in pubpage)
    # cleanup test user
    s1, _ = o.req('DELETE', f'/panel-accounts/{TUSER}'); s2, _ = o.req('DELETE', f'/users/{TUID}')
    dbq(f"DELETE FROM login_fail WHERE k LIKE 'ui:{TUSER}|%' OR k LIKE 'ui:{OWNER}|%' OR k LIKE 'ip:%'")
    left = dbq(f"SELECT COUNT(*) n FROM acl_users WHERE uid={TUID}") + dbq(f"SELECT COUNT(*) n FROM panel_accounts WHERE username='{TUSER}'")
    rec('cleanup: test user, panel account and lockout counters removed', s1 == 200 and s2 == 200 and left.count('"n":0') == 2, left)
    s, _ = o.req('POST', '/auth/logout', {}); s2, _ = o.req('GET', '/auth/session')
    rec('logout invalidates the session', s2 == 401, f'after logout: {s2}')
    n_ok = sum(1 for r in RES if r[1]); print(f'\nRESULT {n_ok}/{len(RES)} passed in {time.time() - t0:.0f}s')
    json.dump(RES, open('/tmp/seemore-e2e.json', 'w'), ensure_ascii=False)
main()
