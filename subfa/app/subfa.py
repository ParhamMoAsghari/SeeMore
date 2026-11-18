#!/usr/bin/env python3
"""subfa: make sure every movie/episode in the library gets a Persian (fa) subtitle.

Flow per item missing fa:
  1. ask Bazarr to search (its own providers)            -> wait BAZARR_GRACE
  2. still missing -> scrape subf2m (season-aware, release-similarity ranking)
  3. write <video>.fa.srt (UTF-8), Bazarr scan-disk, Jellyfin refresh, Bale note
  4. nothing found -> retry with backoff (6h, then 12h)
Stdlib only. Runs inside the bazarr image's python (/lsiopy/bin/python3).
"""
import os, re, io, sys, json, time, zipfile, random, shutil, signal, logging, argparse, threading
import subprocess, tempfile, urllib.request, urllib.parse, urllib.error, html as htmlmod
from difflib import SequenceMatcher
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Runtime overrides written by the seemore panel (/state/overrides.json). Only tuning keys can be
# overridden; URLs and secrets always come from the environment. Read once at start ("reload" class).
_SUBFA_OV_KEYS = {'POLL_SECONDS', 'SWEEP_SECONDS', 'BAZARR_GRACE', 'BACKOFF_HOURS', 'SUBF2M_GAP', 'NOTIFY', 'ENABLED'}
def _subfa_overrides():
    try:
        with open(os.environ.get('SUBFA_OVERRIDES') or '/state/overrides.json') as f: d = json.load(f)
        return {k: str(v) for k, v in d.items() if k in _SUBFA_OV_KEYS} if isinstance(d, dict) else {}
    except Exception: return {}
_OV = _subfa_overrides()
def E(k, d=None): return _OV[k] if k in _OV else os.environ.get(k, d)
SONARR = (E('SONARR_URL') or 'http://sonarr:8989').rstrip('/')
RADARR = (E('RADARR_URL') or 'http://radarr:7878').rstrip('/')
BAZARR = (E('BAZARR_URL') or 'http://bazarr:6767').rstrip('/')
JELLYFIN = (E('JELLYFIN_API') or 'http://jellyfin:8096').rstrip('/')
BOT = (E('BOT_URL') or 'http://seemore:3000').rstrip('/')
SUBF2M = (E('SUBF2M_URL') or 'https://subf2m.co').rstrip('/')
UA = E('SUBF2M_UA') or 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
STATE_FILE = E('STATE_FILE') or '/state/state.json'
POLL = int(E('POLL_SECONDS') or 180)            # quick check of Bazarr lists
SWEEP = int(E('SWEEP_SECONDS') or 6 * 3600)     # full reconcile (scan-disk inconsistent items, profiles)
GRACE = int(E('BAZARR_GRACE') or 900)           # time Bazarr gets before we scrape
BACKOFF = [int(x) for x in (E('BACKOFF_HOURS') or '6,12').split(',')]
GAP = float(E('SUBF2M_GAP') or 8)               # min seconds between subf2m requests
NOTIFY = (E('NOTIFY') or '1') == '1'
ENABLED = (E('ENABLED') or '1') == '1'   # 0 = idle (panel switch)
DEFAULT_PROFILE = int(E('DEFAULT_PROFILE') or 1)
HOOK_PORT = int(E('HOOK_PORT') or 8090)
FA_TAGS = {'fa', 'fas', 'per', 'persian', 'farsi'}
SUB_EXT = ('.srt', '.ass', '.ssa', '.vtt', '.sub')
ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh',
       'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth']

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
log = logging.getLogger('subfa')
DRY = False

# ---------------------------------------------------------------- secrets / config
def bazarr_key():
    k = E('BAZARR_KEY')
    if k: return k
    try:
        txt = open('/bazarr-config/config.yaml').read()
        m = re.search(r'^auth:\n(?:  .*\n)*?  apikey: (\S+)', txt, re.M)
        return m.group(1).strip('\'"') if m else ''
    except OSError:
        return ''

# ---------------------------------------------------------------- http helpers
class HttpErr(Exception):
    def __init__(self, code, msg=''): super().__init__(f'HTTP {code} {msg}'); self.code = code

def http(url, method='GET', headers=None, data=None, timeout=60, tries=3, raw=False):
    h = dict(headers or {})
    if isinstance(data, (dict, list)) and h.get('Content-Type') != 'application/x-www-form-urlencoded':
        data = json.dumps(data).encode(); h.setdefault('Content-Type', 'application/json')
    elif isinstance(data, dict):
        data = urllib.parse.urlencode(data, doseq=True).encode()
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                if raw: return b, r.headers
                if not b: return None
                try: return json.loads(b)
                except ValueError: return b.decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            last = HttpErr(e.code, url.split('?')[0])
            if e.code in (400, 401, 403, 404): raise last
        except Exception as e:  # timeouts, resets
            last = e
        time.sleep(min(60, 3 * 2 ** i) + random.random())
    raise last

class Arr:
    def __init__(self, base, key): self.base, self.key = base, key
    def get(self, p): return http(f'{self.base}/api/v3{p}', headers={'X-Api-Key': self.key})
    def post(self, p, body): return http(f'{self.base}/api/v3{p}', 'POST', {'X-Api-Key': self.key}, body)
    def put(self, p, body): return http(f'{self.base}/api/v3{p}', 'PUT', {'X-Api-Key': self.key}, body)

class Bazarr:
    def __init__(self): self.key = bazarr_key()
    def _h(self): return {'X-API-KEY': self.key}
    def get(self, p): return http(f'{BAZARR}/api{p}', headers=self._h(), timeout=120)
    def form(self, method, p, data, timeout=120):
        return http(f'{BAZARR}/api{p}', method, {**self._h(), 'Content-Type': 'application/x-www-form-urlencoded'}, data, timeout=timeout, tries=1)
    def action(self, kind, ident, action, timeout=120):
        if DRY: log.info('[dry] bazarr %s %s %s', kind, ident, action); return
        if kind == 'm': return self.form('PATCH', '/movies', {'radarrid': ident, 'action': action}, timeout)
        return self.form('PATCH', '/series', {'seriesid': ident, 'action': action}, timeout)
    def set_profile(self, kind, ident, profile):
        if DRY: return
        if kind == 'm': return self.form('POST', '/movies', {'radarrid': [ident], 'profileid': [str(profile)]})
        return self.form('POST', '/series', {'seriesid': [ident], 'profileid': [str(profile)]})

class Jellyfin:
    AUTH = 'MediaBrowser Client="subfa", Device="subfa", DeviceId="subfa", Version="1.0"'
    def __init__(self): self.token = None
    def _login(self):
        d = http(f'{JELLYFIN}/Users/AuthenticateByName', 'POST', {'Authorization': self.AUTH},
                 {'Username': E('JELLYFIN_USER') or '', 'Pw': E('JELLYFIN_PASS') or ''}, tries=2)
        self.token = d['AccessToken']
    def media_updated(self, paths):
        if DRY or not E('JELLYFIN_USER'): return
        body = {'Updates': [{'Path': p, 'UpdateType': 'Modified'} for p in paths]}
        for attempt in range(2):
            try:
                if not self.token: self._login()
                http(f'{JELLYFIN}/Library/Media/Updated', 'POST', {'Authorization': f'{self.AUTH}, Token="{self.token}"'}, body, tries=2)
                return
            except HttpErr as e:
                if e.code == 401 and attempt == 0: self.token = None; continue
                raise

def notify(title, message):
    if DRY or not NOTIFY or not E('HOOK_KEY'): return
    try:
        http(f'{BOT}/hook/{E("HOOK_KEY")}/bazarr', 'POST', {}, {'title': title, 'message': message}, timeout=15, tries=2)
    except Exception as e:
        log.warning('bale notify failed: %s', type(e).__name__)

# ---------------------------------------------------------------- state
class State:
    def __init__(self, path):
        self.path, self.lock = path, threading.RLock()
        try: self.d = json.load(open(path))
        except Exception: self.d = {}
        self.d.setdefault('items', {}); self.d.setdefault('pages', {}); self.d.setdefault('meta', {})
    def item(self, key): return self.d['items'].setdefault(key, {})
    def save(self):
        if DRY: return
        with self.lock:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + '.tmp'
            with open(tmp, 'w') as f: json.dump(self.d, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)

# ---------------------------------------------------------------- text / release helpers
def norm(s):
    s = htmlmod.unescape(str(s or '')).lower().replace('&', ' and ')
    s = re.sub(r"[’'`]", '', s)
    s = re.sub(r'[^0-9a-z\u0600-\u06ff]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def norm_core(s):  # drop "(US)", "(2020)", leading "the"
    s = re.sub(r'\([^)]*\)', ' ', htmlmod.unescape(str(s or '')))
    s = norm(s)
    return re.sub(r'^(the|a|an) ', '', s)

SOURCES = [('bluray', r'blu-?ray|bdrip|brrip|bdremux|\bbd\b|remux'), ('webdl', r'web-?dl'), ('webrip', r'web-?rip'),
           ('web', r'\bweb\b'), ('hdtv', r'hdtv|pdtv'), ('dvd', r'dvd-?rip|dvdscr|\bdvd\b'), ('hdrip', r'hd-?rip')]
SERVICES = r'\b(amzn|nf|hulu|dsnp|hmax|atvp|pcok|pmtp|max|stan|it|ip|crav|hbo)\b'

def rel_info(name):
    n = name.lower().replace('_', '.')
    src = next((k for k, p in SOURCES if re.search(p, n)), '')
    fam = {'webdl': 'web', 'webrip': 'web', 'web': 'web'}.get(src, src)
    res = (re.search(r'(2160|1080|720|576|480)p', n) or [None, ''])[1]
    svc = (re.search(SERVICES, n) or [None, ''])[1]
    m = re.search(r'-\s*([a-z0-9]+)(?:\[[^\]]*\])?(?:\.(?:mkv|mp4|avi|srt))?\s*\)?$', n.strip())
    grp = m.group(1) if m else ''
    if grp in ('hi', 'farsi', 'persian', 'sdh'): grp = ''
    if not grp:
        g2 = re.search(r'\b(yify|yts|rarbg|galaxytv|galaxyrg|psa|tgx|eztv|ettv|mkvcage|pahe|qxr|silence|30nama)\b', n)
        grp = g2.group(1) if g2 else ''
    codec = 'x265' if re.search(r'x265|hevc|h\.?265', n) else ('x264' if re.search(r'x264|h\.?264|avc', n) else '')
    return {'src': src, 'fam': fam, 'res': res, 'svc': svc, 'grp': grp, 'codec': codec}

def rel_score(video, release):
    a, b = rel_info(video), rel_info(release)
    s = 0.0
    if a['grp'] and a['grp'] == b['grp']: s += 100
    if a['fam'] and a['fam'] == b['fam']: s += 30
    if a['src'] and a['src'] == b['src']: s += 5
    if a['svc'] and a['svc'] == b['svc']: s += 10
    if a['res'] and a['res'] == b['res']: s += 5
    if a['codec'] and a['codec'] == b['codec']: s += 2
    s += 10 * SequenceMatcher(None, norm(video), norm(release)).ratio()
    return s

def ep_tags(text):
    """Return set of (season, episode) mentioned and set of seasons mentioned as packs."""
    t = text.lower()
    eps, packs = set(), set()
    for m in re.finditer(r's(\d{1,2})[ ._-]?e(\d{1,3})(?:[ ._-]?-?e?(\d{1,3}))?', t):
        s, e1 = int(m.group(1)), int(m.group(2)); e2 = int(m.group(3)) if m.group(3) else e1
        if e2 < e1 or e2 - e1 > 30: e2 = e1
        for e in range(e1, e2 + 1): eps.add((s, e))
    for m in re.finditer(r'\b(\d{1,2})x(\d{2,3})\b', t): eps.add((int(m.group(1)), int(m.group(2))))
    for m in re.finditer(r'\bs(\d{1,2})\b(?![ ._-]?e\d)|season[ ._-]?(\d{1,2})\b|\bs(\d{1,2})[ ._-]?complete', t):
        packs.add(int(next(g for g in m.groups() if g)))
    return eps, packs

def has_fa_on_disk(video):
    d, base = os.path.dirname(video), os.path.splitext(os.path.basename(video))[0]
    try: names = os.listdir(d)
    except OSError: return False
    for n in names:
        if n.startswith(base + '.') and n.lower().endswith(SUB_EXT):
            tags = set(n[len(base) + 1:].lower().rsplit('.', 1)[0].split('.'))
            if tags & FA_TAGS: return True
    return False

def decode_sub(b):
    if b[:3] == b'\xef\xbb\xbf': cands = ['utf-8-sig']
    elif b[:2] in (b'\xff\xfe', b'\xfe\xff') or b[:200].count(b'\x00') > 20: cands = ['utf-16']
    else: cands = ['utf-8', 'cp1256', 'utf-16']
    for enc in cands:
        try:
            t = b.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
        if enc == 'cp1256' and not re.search('[\u0600-\u06ff]', t): continue
        return t.replace('\r\n', '\n').replace('\r', '\n').lstrip('\ufeff')
    return None

def looks_persian(t):
    if not t: return False
    letters = re.findall('[\u0600-\u06ff]', t)
    latin = re.findall('[A-Za-z]', re.sub(r'<[^>]+>|\{[^}]*\}', '', t))
    return len(letters) > 300 and len(letters) > len(latin)

def extract_archive(blob, depth=0):
    """Return list of (filename, bytes) subtitle files from zip/rar (nested allowed)."""
    out = []
    if depth > 3: return out
    if blob[:2] == b'PK':
        try:
            z = zipfile.ZipFile(io.BytesIO(blob))
        except zipfile.BadZipFile:
            return out
        for info in z.infolist():
            if info.is_dir() or info.file_size > 50 * 2 ** 20: continue
            name = info.filename
            try: name = name.encode('cp437').decode('utf-8')
            except Exception: pass
            data = z.read(info)
            low = name.lower()
            if low.endswith(('.zip', '.rar')) or data[:2] == b'PK' or data[:4] == b'Rar!':
                out += [(f'{name}/{n}', d) for n, d in extract_archive(data, depth + 1)]
            elif low.endswith(SUB_EXT):
                out.append((name, data))
    elif blob[:4] == b'Rar!' and shutil.which('unrar'):
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, 'a.rar'); open(p, 'wb').write(blob)
            subprocess.run(['unrar', 'x', '-y', '-inul', p, td + '/x/'], timeout=120)
            for root, _, files in os.walk(td + '/x'):
                for f in files:
                    fp = os.path.join(root, f); data = open(fp, 'rb').read()
                    if f.lower().endswith(('.zip', '.rar')): out += [(f'{f}/{n}', d) for n, d in extract_archive(data, depth + 1)]
                    elif f.lower().endswith(SUB_EXT): out.append((os.path.relpath(fp, td + '/x'), data))
    elif decode_sub(blob) and '-->' in (decode_sub(blob) or ''):
        out.append(('subtitle.srt', blob))
    return out

# ---------------------------------------------------------------- subf2m client
class Subf2m:
    def __init__(self, state):
        self.state, self.last, self.lock, self.paused_until = state, 0.0, threading.Lock(), 0
    def _get(self, path, raw=False):
        if time.time() < self.paused_until: raise RuntimeError('subf2m paused (rate limited)')
        with self.lock:
            wait = self.last + GAP - time.time()
            if wait > 0: time.sleep(wait)
            try:
                url = path if path.startswith('http') else SUBF2M + path
                return http(url, headers={'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Referer': SUBF2M + '/'},
                            timeout=90, tries=2, raw=raw)
            except HttpErr as e:
                if e.code in (403, 429, 503): self.paused_until = time.time() + 1800
                raise
            finally:
                self.last = time.time()

    def search(self, q):
        h = self._get('/subtitles/searchbytitle?query=' + urllib.parse.quote_plus(q))
        if not isinstance(h, str): return []
        h = h[h.find('search-result'):]
        res, seen = [], set()
        for m in re.finditer(r'<a href="(/subtitles/[^"/?]+)">([^<]+)</a>\s*</div>\s*<div class="subtle count">\s*(\d+)', h):
            slug, title, n = m.group(1), htmlmod.unescape(m.group(2)).strip(), int(m.group(3))
            if slug in seen: continue
            seen.add(slug)
            ym = re.search(r'\((\d{4})\)\s*$', title)
            year = int(ym.group(1)) if ym else None
            name = re.sub(r'\s*\(\d{4}\)\s*$', '', title).strip()
            season = None
            sm = re.search(r'\s-\s(\w+)\sSeason$', name)
            sm2 = re.search(r'\s-\sSeason\s(\d+)$', name)
            if sm and sm.group(1) in ORD: season = ORD.index(sm.group(1)); name = name[:sm.start()]
            elif sm2: season = int(sm2.group(1)); name = name[:sm2.start()]
            elif re.search(r'\s-\s(Others|Specials)$', name): season = 0; name = re.sub(r'\s-\s\w+$', '', name)
            res.append({'slug': slug, 'title': title, 'name': name.strip(), 'year': year, 'season': season, 'count': n})
        return res

    def items(self, slug):
        h = self._get(slug + '/farsi_persian')
        if not isinstance(h, str): return []
        out = []
        for chunk in h.split("<li class='item")[1:]:
            d = re.search(r"class='download icon-download' href='([^']+)'", chunk) or re.search(r"href='(/subtitles/[^']+/farsi_persian/\d+)'", chunk)
            if not d: continue
            ul = chunk.split('</ul>')[0]
            rels = [htmlmod.unescape(x).strip() for x in re.findall(r'<li>([^<]+)</li>', ul)]
            rate = re.search(r"<span class='rate (\w+)'", chunk)
            com = re.search(r'<p>(.*?)</p>', chunk, re.S)
            comment = htmlmod.unescape(re.sub(r'<[^>]+>', ' ', com.group(1))).strip() if com else ''
            out.append({'url': d.group(1), 'releases': [r for r in rels if r], 'rating': rate.group(1) if rate else '', 'comment': comment})
        return out

    def download(self, item_url):
        try:
            blob, hdr = self._get(item_url.rstrip('/') + '/download', raw=True)
        except HttpErr:
            page = self._get(item_url)
            m = re.search(r'href="([^"]*/download[^"]*)"', page if isinstance(page, str) else '')
            if not m: raise
            blob, hdr = self._get(htmlmod.unescape(m.group(1)), raw=True)
        return blob

    # -- page resolution, cached 7 days (negative 1 day)
    def find_page(self, kind, titles, year, season=None):
        ck = f'{kind}|{norm(titles[0])}|{year}|{season}'
        c = self.state.d['pages'].get(ck)
        if c and time.time() - c['t'] < (7 * 86400 if c['slug'] else 86400): return c['slug']
        slug = self._resolve(kind, titles, year, season)
        self.state.d['pages'][ck] = {'slug': slug, 't': time.time()}; self.state.save()
        return slug

    def _resolve(self, kind, titles, year, season):
        wanted = {norm(t) for t in titles if t} | {norm_core(t) for t in titles if t}
        def name_ok(name):
            n1, n2 = norm(name), norm_core(name)
            parts = {n1, n2} | {norm_core(p) for p in re.split(r'[()/]', name) if p.strip()}
            return bool(parts & wanted)
        queries = []
        for t in titles[:3]:
            if kind == 's' and season: queries += [f'{t} {ORD[season] if season < len(ORD) else ""} Season'.replace('  ', ' '), f'{t} Season {season}']
            queries.append(t)
        tried = set()
        for q in queries:
            if q in tried: continue
            tried.add(q)
            try: res = self.search(q)
            except Exception as e:
                log.warning('subf2m search failed (%s): %s', q, e); continue
            hits = []
            for r in res:
                if not name_ok(r['name']): continue
                if kind == 'm':
                    if r['season'] is not None: continue
                    if year and r['year'] and abs(r['year'] - year) > 1: continue
                    hits.append((0 if r['year'] == year else 1, -r['count'], r))
                else:
                    rs = r['season']
                    if rs == season or (season == 1 and rs is None and (not year or not r['year'] or abs(r['year'] - year) <= 1)):
                        hits.append((0 if rs == season else 1, -r['count'], r))
            if hits:
                hits.sort(key=lambda x: x[:2])
                log.info('subf2m page for %s %s%s -> %s', titles[0], year or '', f' S{season}' if season else '', hits[0][2]['title'])
                return hits[0][2]['slug']
        return None

# ---------------------------------------------------------------- core
class SubFa:
    def __init__(self, state):
        self.state = state
        self.sonarr = Arr(SONARR, E('SONARR_KEY') or '')
        self.radarr = Arr(RADARR, E('RADARR_KEY') or '')
        self.bz = Bazarr()
        self.jf = Jellyfin()
        self.sf = Subf2m(state)
        self.run_lock = threading.Lock()
        self.kick = threading.Event()

    # ---- discovery: which videos lack fa?
    @staticmethod
    def _has_fa(subs):
        return any((s.get('code2') == 'fa' or s.get('code3') in ('fas', 'per')) for s in (subs or []))

    def missing(self, reconcile=False):
        """Return list of dicts {kind, key, arr_id, series_id, season, episode, path}"""
        out = []
        series = self.bz.get('/series?start=0&length=-1')['data']
        for s in series:
            if s.get('profileId') in (None, '', 0):
                log.info('assigning default profile to series %s', s['title']); self.bz.set_profile('s', s['sonarrSeriesId'], DEFAULT_PROFILE)
            eps = self.bz.get(f'/episodes?seriesid[]={s["sonarrSeriesId"]}')['data']
            inconsistent = False
            for e in eps:
                p = e.get('path')
                if not p or not os.path.exists(p): continue
                if self._has_fa(e.get('subtitles')) or has_fa_on_disk(p): continue
                if not e.get('missing_subtitles') and not e.get('subtitles'): inconsistent = True
                out.append({'kind': 's', 'key': f'e:{e["sonarrEpisodeId"]}', 'arr_id': e['sonarrEpisodeId'], 'series_id': s['sonarrSeriesId'],
                            'title': s['title'], 'season': e['season'], 'episode': e['episode'], 'path': p})
            if inconsistent and reconcile:
                log.info('scan-disk (inconsistent subtitle state) series %s', s['title']); self._safe(self.bz.action, 's', s['sonarrSeriesId'], 'scan-disk')
        for m in self.bz.get('/movies?start=0&length=-1')['data']:
            if m.get('profileId') in (None, '', 0):
                log.info('assigning default profile to movie %s', m['title']); self.bz.set_profile('m', m['radarrId'], DEFAULT_PROFILE)
            p = m.get('path')
            if not p or not os.path.exists(p): continue
            if self._has_fa(m.get('subtitles')) or has_fa_on_disk(p): continue
            if reconcile and not m.get('missing_subtitles') and not m.get('subtitles'):
                log.info('scan-disk (inconsistent subtitle state) movie %s', m['title']); self._safe(self.bz.action, 'm', m['radarrId'], 'scan-disk')
            out.append({'kind': 'm', 'key': f'm:{m["radarrId"]}', 'arr_id': m['radarrId'], 'title': m['title'], 'year': m.get('year'), 'path': p})
        return out

    @staticmethod
    def _safe(fn, *a, **k):
        try: return fn(*a, **k)
        except Exception as e: log.warning('%s failed: %s', getattr(fn, '__name__', 'call'), e)

    # ---- one pass
    def run(self, reconcile=False, only=None):
        if not self.run_lock.acquire(blocking=False): return
        try:
            items = self.missing(reconcile)
            if only: items = [i for i in items if only(i)]
            now = time.time()
            due_bazarr, due_scrape = {}, {}
            live = set()
            for it in items:
                st = self.state.item(it['key']); live.add(it['key'])
                if st.get('path') != it['path']:  # new or upgraded file -> reset
                    st.clear(); st.update({'path': it['path'], 'first': now})
                if st.get('next', 0) > now: continue
                group = ('m', it['arr_id']) if it['kind'] == 'm' else ('s', it['series_id'], it['season'])
                if not st.get('bz'): due_bazarr.setdefault(group, []).append(it)
                elif now - st['bz'] >= GRACE: due_scrape.setdefault(group, []).append(it)
            # forget finished items
            for k in list(self.state.d['items']):
                if k not in live and self.state.d['items'][k].get('path') and not os.path.exists(self.state.d['items'][k]['path']):
                    del self.state.d['items'][k]
            # 1) Bazarr own search (one call per series / movie)
            done_series = set()
            for g, its in due_bazarr.items():
                kind, ident = ('m', g[1]) if g[0] == 'm' else ('s', g[1])
                if (kind, ident) not in done_series:
                    done_series.add((kind, ident))
                    log.info('bazarr search-missing for %s (%d item(s))', its[0]['title'], len(its))
                    threading.Thread(target=self._safe, args=(self.bz.action, kind, ident, 'search-missing'), kwargs={'timeout': 900}, daemon=True).start()
                for it in its: self.state.item(it['key'])['bz'] = time.time()
                self.state.save()
            # 2) our scraper
            for g, its in due_scrape.items():
                still = [i for i in its if not has_fa_on_disk(i['path'])]
                if still: self._safe(self.scrape_group, still)
            self.state.d['meta']['last_run'] = time.time(); self.state.save()
        finally:
            self.run_lock.release()

    # ---- metadata from Sonarr / Radarr
    def _titles(self, obj):
        t = [obj.get('title'), obj.get('originalTitle')] + [a.get('title') for a in obj.get('alternateTitles') or []]
        seen, out = set(), []
        for x in t:
            if x and norm(x) not in seen: seen.add(norm(x)); out.append(x)
        return out

    def scrape_group(self, its):
        first = its[0]
        if first['kind'] == 'm':
            mv = self.radarr.get(f'/movie/{first["arr_id"]}')
            mf = mv.get('movieFile') or {}
            scene = mf.get('sceneName') or os.path.splitext(os.path.basename(first['path']))[0]
            runtime = (mf.get('mediaInfo') or {}).get('runTime') or ''
            slug = self.sf.find_page('m', self._titles(mv), mv.get('year'))
            ok = self._scrape_movie(first, slug, scene, runtime) if slug else False
            self._finish(its, {first['key']} if ok else set(), mv.get('title'), None, slug)
        else:
            se = self.sonarr.get(f'/series/{first["series_id"]}')
            season = first['season']
            files = {f['id']: f for f in self.sonarr.get(f'/episodefile?seriesId={first["series_id"]}')}
            eps = {e['id']: e for e in self.sonarr.get(f'/episode?seriesId={first["series_id"]}')}
            for it in its:
                f = files.get((eps.get(it['arr_id']) or {}).get('episodeFileId'))
                it['scene'] = (f or {}).get('sceneName') or os.path.splitext(os.path.basename(it['path']))[0]
            year = se.get('year')
            titles = self._titles(se)
            slug = self.sf.find_page('s', titles, year, season)
            got = self._scrape_season(its, slug, season) if slug else set()
            self._finish(its, got, se.get('title'), season, slug)

    def _finish(self, its, got, title, season, slug):
        now = time.time()
        for it in its:
            st = self.state.item(it['key']); st.setdefault('path', it['path'])
            if it['key'] in got:
                st.update({'done': now, 'src': 'subf2m', 'next': now + 30 * 86400})
            else:
                n = st.get('fails', 0); st['fails'] = n + 1
                st['next'] = now + 3600 * BACKOFF[min(n, len(BACKOFF) - 1)]
                st['why'] = 'no subf2m page' if not slug else 'no matching farsi subtitle'
        self.state.save()
        if got and not DRY:
            first = its[0]
            if first['kind'] == 'm': self._safe(self.bz.action, 'm', first['arr_id'], 'scan-disk')
            else: self._safe(self.bz.action, 's', first['series_id'], 'scan-disk')
            self._safe(self.jf.media_updated, sorted({os.path.dirname(i['path']) for i in its if i['key'] in got}))
            if first['kind'] == 'm': msg = f'🎬 {title}'
            else:
                n = len(got); msg = f'📺 {title} · فصل {season}' + (f' · {n} قسمت' if n > 1 else f' · قسمت {next(i["episode"] for i in its if i["key"] in got)}')
            notify('زیرنویس فارسی اضافه شد (subf2m)', msg)
        log.info('%s%s: wrote %d/%d', title, f' S{season:02d}' if season else '', len(got), len(its))

    # ---- ranking & writing
    def _rank(self, items, scene, need_eps=None, season=None, runtime=''):
        ranked = []
        rt = self._secs(runtime)
        for it in items:
            rels = it['releases'] or [it['comment']]
            best = max(rel_score(scene, r) for r in rels) if rels else 0
            cover = None
            if need_eps is not None:
                eps, packs = set(), set()
                for r in rels:
                    e, p = ep_tags(r); eps |= e; packs |= p
                if season in packs and not any(s == season for s, _ in eps): cover = set(need_eps)  # season pack
                elif season in packs: cover = set(need_eps)  # mixed list incl. pack names
                else: cover = {e for s, e in eps if s == season} & set(need_eps)
                if not cover: continue
            bonus = 0
            if rt:
                for m in re.finditer(r'(\d{1,2}):(\d{2}):(\d{2})|\b(\d):(\d{2})\b', it['comment']):
                    secs = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) if m.group(1) else int(m.group(4)) * 3600 + int(m.group(5)) * 60
                    if abs(secs - rt) < 90: bonus = 25
            score = best + bonus + (8 if cover and need_eps and len(cover) == len(need_eps) and len(need_eps) > 1 else 0) + (4 if it['rating'] == 'good' else 0)
            ranked.append((score, it, cover))
        ranked.sort(key=lambda x: -x[0])
        return ranked

    @staticmethod
    def _secs(rt):
        m = re.match(r'(?:(\d+):)?(\d+):(\d+)', str(rt or ''))
        if not m: return 0
        return int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))

    def _files_from(self, item_url):
        blob = self.sf.download(item_url)
        files = []
        for name, data in extract_archive(blob):
            text = decode_sub(data)
            if looks_persian(text): files.append((name, text))
        return files

    def _write(self, video, name, text):
        ext = os.path.splitext(name)[1].lower()
        ext = ext if ext in ('.srt', '.ass', '.ssa', '.vtt') else '.srt'
        target = os.path.splitext(video)[0] + '.fa' + ext
        if DRY:
            log.info('[dry] would write %s (%d chars) from %s', os.path.basename(target), len(text), name); return True
        if os.path.exists(target) or has_fa_on_disk(video):
            log.info('fa subtitle appeared meanwhile, skip %s', os.path.basename(target)); return True
        tmp = target + '.part'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f: f.write(text)
        try: os.chown(tmp, int(os.environ.get('PUID') or 1000), int(os.environ.get('PGID') or 1000))
        except OSError: pass
        os.chmod(tmp, 0o644); os.replace(tmp, target)
        log.info('wrote %s', target)
        return True

    def _scrape_movie(self, it, slug, scene, runtime):
        items = self.sf.items(slug)
        ranked = self._rank(items, scene, runtime=runtime)
        log.info('%s: %d farsi item(s) on %s; best: %s', it['title'], len(items), slug,
                 '; '.join(f'{s:.0f}:{(i["releases"] or ["?"])[0][:60]}' for s, i, _ in ranked[:3]))
        for score, item, _ in ranked[:3]:
            try: files = self._files_from(item['url'])
            except Exception as e:
                log.warning('download failed %s: %s', item['url'], e); continue
            files = [f for f in files if not re.search(r'\bcd\s*2\b|part\s*2', f[0].lower())]
            if not files: continue
            name, text = max(files, key=lambda f: (rel_score(scene, os.path.basename(f[0])), f[0].lower().endswith('.srt'), len(f[1])))
            log.info('  picked %s from %s', name, item['url'])
            return self._write(it['path'], name, text)
        return False

    def _scrape_season(self, its, slug, season):
        items = self.sf.items(slug)
        need = {i['episode']: i for i in its}
        scene = its[0].get('scene', '')
        got, tried = set(), set()
        log.info('%s S%02d: %d farsi item(s) on %s, need E%s', its[0]['title'], season, len(items), slug,
                 ','.join(str(e) for e in sorted(need)))
        downloads = 0
        while need and downloads < 12:
            ranked = [(s, i, c) for s, i, c in self._rank(items, scene, set(need), season) if i['url'] not in tried]
            if not ranked: break
            # best item for the episode that has the weakest options first; ties -> item covering most episodes
            score, item, cover = max(ranked, key=lambda x: (round(x[0] / 20), len(x[2]), x[0]))
            tried.add(item['url']); downloads += 1
            log.info('  trying %s (score %.0f, covers E%s): %s', item['url'], score, ','.join(map(str, sorted(cover))), (item['releases'] or ['?'])[0][:70])
            try: files = self._files_from(item['url'])
            except Exception as e:
                log.warning('download failed %s: %s', item['url'], e); continue
            byep = {}
            for name, text in files:
                eps, _ = ep_tags(os.path.basename(name))
                if not eps: eps, _ = ep_tags(name)
                epn = {e for s, e in eps if s == season}
                if not epn:
                    m = re.search(r'(?:\be|episode|ep|قسمت)[ ._-]?(\d{1,3})\b', name.lower())
                    if m: epn = {int(m.group(1))}
                    elif len(files) == 1 and len(cover) == 1: epn = set(cover)
                for e in epn: byep.setdefault(e, []).append((name, text))
            for e in list(need):
                if e not in byep: continue
                vid = need[e]
                name, text = max(byep[e], key=lambda f: (rel_score(vid.get('scene', ''), os.path.basename(f[0])), f[0].lower().endswith('.srt'), len(f[1])))
                if self._write(vid['path'], name, text):
                    got.add(vid['key']); del need[e]
        return got

    # ---- loop
    def loop(self):
        last_sweep = self.state.d['meta'].get('last_sweep', 0)
        if not ENABLED: log.info('subfa disabled (ENABLED=0 override); idling')
        while True:
            if not ENABLED:
                self.kick.wait(POLL); self.kick.clear(); continue
            try:
                reconcile = time.time() - last_sweep >= SWEEP
                self.run(reconcile=reconcile)
                if reconcile:
                    last_sweep = time.time(); self.state.d['meta']['last_sweep'] = last_sweep; self.state.save()
            except Exception as e:
                log.warning('run failed: %s', e)
            self.kick.wait(POLL); 
            if self.kick.is_set():
                self.kick.clear(); time.sleep(60)  # give Bazarr a minute to sync the new file

# ---------------------------------------------------------------- webhook (Sonarr/Radarr "Webhook" connection)
def serve(app):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            ok = self.path == '/health'
            self.send_response(200 if ok else 404); self.end_headers(); self.wfile.write(b'ok' if ok else b'')
        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(min(n, 2_000_000))
            key = E('SUBFA_HOOK_KEY') or ''
            if not key or self.path != f'/hook/{key}':
                self.send_response(404); self.end_headers(); return
            self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
            try: ev = json.loads(body).get('eventType', '')
            except Exception: ev = ''
            if ev in ('Download', 'Rename', 'Test'):
                log.info('webhook %s -> run soon', ev); app.kick.set()
    ThreadingHTTPServer(('0.0.0.0', HOOK_PORT), H).serve_forever()

def main():
    global DRY
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='find & download, print what would be written; change nothing')
    ap.add_argument('--once', action='store_true', help='one pass then exit')
    ap.add_argument('--series', help='limit to series title (substring)')
    ap.add_argument('--season', type=int)
    ap.add_argument('--movie', help='limit to movie title (substring)')
    ap.add_argument('--now', action='store_true', help='ignore grace/backoff (scrape immediately)')
    ap.add_argument('--include-present', action='store_true', help='(dry-run) also test items that already have fa')
    a = ap.parse_args()
    DRY = a.dry_run
    st = State(STATE_FILE if not DRY else '/tmp/subfa-dry.json')
    app = SubFa(st)
    if a.once or DRY or a.series or a.movie:
        def only(i):
            if a.series: return i['kind'] == 's' and a.series.lower() in i['title'].lower() and (not a.season or i['season'] == a.season)
            if a.movie: return i['kind'] == 'm' and a.movie.lower() in i['title'].lower()
            return True
        if a.now or DRY:
            for k in list(st.d['items']): st.d['items'][k].update({'bz': 1, 'next': 0})
        if a.include_present:
            global has_fa_on_disk
            real = has_fa_on_disk; has_fa_on_disk = lambda p: False; SubFa._has_fa = staticmethod(lambda s: False)
            items = [i for i in app.missing() if only(i)]
            for i in items: st.item(i['key']).update({'path': i['path'], 'bz': 1, 'next': 0})
            groups = {}
            for i in items: groups.setdefault((i['kind'], i.get('series_id', i['arr_id']), i.get('season')), []).append(i)
            for g in groups.values(): app.scrape_group(g)
            return
        if a.now:
            items = [i for i in app.missing() if only(i)]
            groups = {}
            for i in items: groups.setdefault((i['kind'], i.get('series_id', i['arr_id']), i.get('season')), []).append(i)
            for g in groups.values(): app._safe(app.scrape_group, g)
            return
        app.run(reconcile=True, only=only); return
    log.info('subfa started: poll %ss, sweep %ss, grace %ss, backoff %sh, subf2m gap %ss', POLL, SWEEP, GRACE, BACKOFF, GAP)
    threading.Thread(target=serve, args=(app,), daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    app.loop()

if __name__ == '__main__':
    main()
