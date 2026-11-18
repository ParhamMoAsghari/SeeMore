'use strict';
// Runtime settings (tunables + feature flags) stored in SQLite table `settings` (k, v JSON, t, by).
// Read through get(); changes apply live without a restart: set() updates the in-memory cache and
// emits 'change', and a 5 s poll picks up writes made by another process (e.g. a future web panel
// writing the same DB). Precedence: DB value > environment variable (env name in DEFS) > default.
// Secrets (bot token, API keys, passwords) are NEVER stored here; they stay in env only.
const { EventEmitter } = require('events');
const DB = require('./db');
const bad = (m) => Object.assign(new Error(m), { status: 400, user: true });

// key: [default, type, env var, description]
const DEFS = {
  'features.usb':        [true,  'bool', null, 'External drives section (browse, copy to drive, eject)'],
  'features.usb_import': [true,  'bool', null, 'Import from external drives to the server'],
  'features.usb_manage': [true,  'bool', null, 'Move / rename / delete on external drives'],
  'features.files':      [true,  'bool', null, 'Read-only server file browser + metadata'],
  'features.links':      [true,  'bool', null, 'Download links (ZIP/RAR/file)'],
  'features.links_rar':  [true,  'bool', null, 'Offer RAR as a link format'],
  'features.requests':   [true,  'bool', null, 'Search + request downloads'],
  'features.notify':     [true,  'bool', null, 'Media notifications (grab/import/subtitle)'],
  'links.public_base':   ['https://dl.example.com', 'str', 'DL_PUBLIC', 'Public base URL of download links'],
  'links.lan_base':      ['', 'str', 'DL_LAN', 'LAN base URL of download links'],
  'links.rate_per_min':  [90, 'int', null, 'Max requests per minute per IP'],
  'links.max_parallel':  [6, 'int', null, 'Max parallel downloads per IP'],
  'links.bad_token_block': [20, 'int', null, 'Invalid tokens before a 10-minute IP block'],
  'links.rar_min_free_mb': [512, 'int', null, 'Free space to keep when building RAR'],
  'jellyfin.public_url': ['http://jellyfin.example.com', 'str', 'JELLYFIN_URL', 'Jellyfin URL shown in cards'],
  'acl.refusal_text':    ['این ربات خصوصی است.', 'str', null, 'Reply to unknown users on /start (empty = silent)'],
  'backup.keep_days':    [14, 'int', null, 'Daily DB backups to keep'],
  'backup.dir':          ['/data/backups/seemore', 'str', 'BACKUP_DIR', 'Backup directory'],
  'usb.default_mode':    ['protected', 'str', 'USB_DEFAULT_MODE', 'Mode of a newly plugged, unknown drive: protected = read-only mount, check-only fsck, nothing written; writable = read-write', { enum: ['protected', 'writable'] }],
  'usb.auto_repair':     [false, 'bool', null, 'Run a repairing fsck when a WRITABLE drive is plugged in (protected drives are never repaired)'],
  'usb.ignore_label_regex': ['', 'str', null, 'Drives whose label matches this regex are invisible to the bot (no notice, no listing, no marker)'],
  'jobs.progress_every_s': [4, 'int', null, 'Progress message edit interval (seconds)', { min: 2, max: 60 }],
  // ---- seemore API / panel ----
  'panel.session_hours': [168, 'int', null, 'Panel session lifetime (hours, sliding)', { min: 1, max: 2160 }],
  'panel.lock_after':    [5, 'int', null, 'Failed logins (same user + IP) before a lockout', { min: 3, max: 50 }],
  'panel.lock_minutes':  [15, 'int', null, 'Lockout duration (minutes)', { min: 1, max: 1440 }],
  'panel.ip_lock_after': [20, 'int', null, 'Failed logins from one IP within an hour before the IP is blocked for an hour', { min: 5, max: 500 }],
  // ---- bot ----
  'bot.menu_hidden':     ['', 'str', null, 'Main-menu buttons to hide (comma list of: search,dl,lib,news,cal,srv,usb,files,links,acl)', { re: /^[a-z,\s]*$/ }],
  'notify.types':        ['grab,import,failed,health,manual,subtitle,outage', 'str', null, 'Media notification types that are sent (comma list of: grab,import,failed,health,manual,subtitle,outage)', { re: /^[a-z,\s]*$/ }],
  'bot.messenger':       ['telegram', 'str', 'MESSENGER', 'Messenger adapter for the bot interface', { enum: ['telegram', 'bale'] }],
  'bot.update_mode':     ['polling', 'str', 'BOT_UPDATE_MODE', 'How the bot receives updates: polling (getUpdates long-poll, works behind NAT) or webhook (Telegram only; needs bot.webhook_url)', { enum: ['polling', 'webhook'] }],
  'bot.webhook_url':     ['', 'str', 'BOT_WEBHOOK_URL', 'Public HTTPS URL that Telegram posts updates to in webhook mode, e.g. https://bot.example.com/telegram (proxy it to the webhook port)', { re: /^$|^https:\/\/[^\s]+$/ }],
  'bot.webhook_port':    [3003, 'int', 'BOT_WEBHOOK_PORT', 'Port of the webhook receiver inside the container (webhook mode)', { min: 1024, max: 65535 }],
  'bot.token_env':       ['TELEGRAM_TOKEN', 'str', 'BOT_TOKEN_ENV', 'Name of the environment variable that holds the bot token (the token itself never leaves .env)', { re: /^[A-Z][A-Z0-9_]{1,40}$/ }],
  // ---- schedules ----
  'schedule.backup_check_min': [60, 'int', null, 'How often the daily DB backup is checked (minutes)', { min: 5, max: 1440 }],
  'schedule.grant_sweep_s':    [60, 'int', null, 'Expired-grant sweep interval (seconds)', { min: 10, max: 3600 }],
  'schedule.checkpoint_min':   [5, 'int', null, 'SQLite WAL checkpoint interval (minutes)', { min: 1, max: 120 }],
  // ---- requests (defaults used by the panel / API) ----
  'requests.quality_m':  ['1080', 'str', null, 'Default movie quality key (1080, 4k, 10b)', { enum: ['1080', '4k', '10b'] }],
  'requests.quality_s':  ['1080', 'str', null, 'Default series quality key (1080, hd, 4k, 10b)', { enum: ['1080', 'hd', '4k', '10b'] }],
  'requests.root_m':     ['', 'str', 'MOVIES_ROOT', 'Radarr root folder for new movies (empty = first matching /data/media/movies)'],
  'requests.root_s':     ['', 'str', 'TV_ROOT', 'Sonarr root folder for new series (empty = first matching /data/media/tv)'],
  // ---- domains (Caddy) ----
  'domains.panel_public': ['panel.example.com', 'str', 'PANEL_PUBLIC_HOST', 'Public HTTPS host of the panel (empty = off)', { host: true }],
  'domains.panel_lan':    ['', 'str', 'PANEL_LAN_HOST', 'LAN plain-HTTP host of the panel (empty = off)', { host: true }],
  'domains.dl_public':    ['dl.example.com', 'str', 'DL_PUBLIC_HOST', 'Public HTTPS host of download links (empty = off)', { host: true }],
  'domains.dl_lan':       ['', 'str', 'DL_LAN_HOST', 'LAN plain-HTTP host of download links (empty = off)', { host: true }],
  // ---- single sign-on (Caddy service blocks + parent-domain cookie; see docs/sso.md) ----
  'sso.enabled':         [false, 'bool', 'SSO_ENABLED', 'Panel single sign-on for the media services (Caddy forward-auth + server-side app login); each app keeps its own login'],
  'sso.public_domain':   ['', 'str', 'SSO_PUBLIC_DOMAIN', 'Public parent domain of the service hosts (<service>.<domain>, HTTPS); empty = off', { host: true }],
  'sso.lan_domain':      ['', 'str', 'SSO_LAN_DOMAIN', 'LAN parent domain of the service hosts (<service>.<domain>, plain HTTP); empty = off', { host: true }],
  'sso.oidc':            [false, 'bool', 'SSO_OIDC', 'Serve the OpenID Connect provider (/oidc/*, discovery) on the panel host, e.g. for the Jellyfin SSO plugin'],
  'sso.oidc_issuer':     ['', 'str', 'SSO_OIDC_ISSUER', 'Fixed OIDC issuer URL (empty = derived from the request host), e.g. https://panel.example.com'],
  'sso.jellyfin_deny':   ['', 'str', 'SSO_JELLYFIN_DENY', 'Jellyfin account names (comma-separated) that the OIDC sign-in must never log anyone into, in addition to every Jellyfin administrator'],
  'sso.jellyfin_libraries': ['', 'str', 'SSO_JELLYFIN_LIBRARIES', 'Jellyfin libraries (names, comma-separated) given to accounts the OIDC sign-in creates on first login; empty = every library not used by a denied account'],
  'sso.jellyfin_map':    ['', 'str', 'SSO_JELLYFIN_MAP', 'Exact 1:1 mapping panel username=Jellyfin account (comma-separated). A mapped panel user signs in to that EXISTING non-admin Jellyfin account (never created or changed) even if the name is in sso.jellyfin_deny; nobody else can reach it'],
  // ---- network / container ----
  'net.api_port':        [3002, 'int', 'API_PORT', 'Port of the seemore API + panel inside the container', { min: 1024, max: 65535 }],
  'net.links_port':      [3001, 'int', 'DL_PORT', 'Port of the download-link server inside the container', { min: 1024, max: 65535 }],
  'container.mem_limit': ['512m', 'str', null, 'Memory limit of the seemore container (compose mem_limit)', { re: /^\d{3,5}m$/ }],
  'container.panel_bind': ['', 'str', null, 'Optional direct host binding for the panel, e.g. 127.0.0.1:8098 or <LAN-IP>:8098 (empty = only through Caddy). Public binds are refused because Docker bypasses the firewall.', { re: /^$|^(127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):\d{2,5}$/ }],
  'ctl.restartable':     ['seemore,subfa,bazarr,qbittorrent,radarr,sonarr,prowlarr,jellyfin,flaresolverr,jellyseerr,caddy', 'str', 'CTL_RESTARTABLE', 'Containers the panel may restart / read logs of'],
};
// validation spec (5th element): { min, max, enum, re, host }
const HOST_RE = /^$|^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
function validate(k, v) {
  const d = DEFS[k]; const spec = d && d[4]; if (!spec) return v;
  if (spec.min != null && v < spec.min) throw bad(`${k}: minimum is ${spec.min}`);
  if (spec.max != null && v > spec.max) throw bad(`${k}: maximum is ${spec.max}`);
  if (spec.enum && !spec.enum.includes(v)) throw bad(`${k}: must be one of ${spec.enum.join(', ')}`);
  if (spec.re && !spec.re.test(String(v))) throw bad(`${k}: invalid format`);
  if (spec.host && !HOST_RE.test(String(v))) throw bad(`${k}: invalid host name`);
  return v;
}
const ev = new EventEmitter();
let cache = new Map(); let lastT = 0; let timer = null;
function coerce(type, v) {
  if (type === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
  if (type === 'int') { const n = Number(v); if (!Number.isFinite(n)) throw bad('not a number'); return Math.round(n); }
  return String(v);
}
function load() {
  const rows = DB.all('SELECT k, v, t FROM settings');
  const next = new Map();
  for (const r of rows) { try { next.set(r.k, JSON.parse(r.v)); } catch {} lastT = Math.max(lastT, r.t); }
  const changed = [...new Set([...cache.keys(), ...next.keys()])].filter((k) => JSON.stringify(cache.get(k)) !== JSON.stringify(next.get(k)));
  cache = next;
  for (const k of changed) ev.emit('change', k, get(k));
}
function start() { load(); if (!timer) { timer = setInterval(() => { try { const r = DB.one('SELECT MAX(t) t, COUNT(*) n FROM settings'); if ((r.t || 0) !== lastT || r.n !== cache.size) load(); } catch {} }, 5000); timer.unref && timer.unref(); } }
function get(k) {
  const d = DEFS[k];
  if (cache.has(k)) return d ? coerce(d[1], cache.get(k)) : cache.get(k);
  if (d && d[2] && process.env[d[2]] != null && process.env[d[2]] !== '') return coerce(d[1], process.env[d[2]]);
  return d ? d[0] : undefined;
}
const on = (k) => get(k) === true;
function set(k, v, by = null) {
  const d = DEFS[k]; if (!d) throw bad('unknown setting ' + k);
  const val = validate(k, coerce(d[1], v));
  if (k === 'usb.ignore_label_regex' && val) { try { new RegExp(val); } catch { throw bad('invalid regex'); } }
  const t = Math.max(Date.now(), lastT + 1);
  DB.run('INSERT INTO settings(k,v,t,by) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t, by=excluded.by', k, JSON.stringify(val), t, by);
  cache.set(k, val); lastT = t; ev.emit('change', k, val);
  return val;
}
// value the key would have without a DB override (env var, else built-in default)
function fallback(k) { const d = DEFS[k]; if (!d) return undefined; if (d[2] && process.env[d[2]] != null && process.env[d[2]] !== '') return coerce(d[1], process.env[d[2]]); return d[0]; }
function reset(k) { DB.run('DELETE FROM settings WHERE k=?', k); cache.delete(k); ev.emit('change', k, get(k)); return get(k); }
const all = () => Object.entries(DEFS).map(([k, [def, type, env, desc, spec]]) => ({ key: k, value: get(k), default: def, type, env, description: desc, overridden: cache.has(k), spec: spec ? { ...spec, re: spec.re ? String(spec.re) : undefined } : undefined }));
const list = (k) => String(get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
module.exports = { DEFS, get, on, set, reset, fallback, all, start, load, ev, validate, coerce, list };
