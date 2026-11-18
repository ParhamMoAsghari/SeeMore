'use strict';
// Single sign-on hub: the seemore panel is the identity provider for the other services on the stack.
//
// Design (see docs/sso.md):
//  * Login to the panel also sets a second cookie `sm_sso` scoped to the parent domain (e.g. .example.com) so the
//    service sub-domains can see it. It is NOT the panel session id: it is a separate random token that only
//    works for the endpoints in this file (check / enter / launcher), never for the panel API. It is HttpOnly,
//    SameSite=Lax and Secure on HTTPS, and Caddy strips it from the requests it forwards to the apps.
//  * Permissions: one `svc.<id>` permission per service (owner has all). They are normal seemore permissions,
//    managed on the Users page / bot like any other.
//  * Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent, Seerr: the apps keep their own forms login untouched. Caddy asks
//    `/sso/enter` for browser navigations that carry a panel SSO cookie but no app session yet. If the panel
//    session is valid AND the user holds the svc permission, seemore performs the app's normal login server-side
//    (service account kept in the existing secrets), hands the resulting *session cookie only* to the browser and
//    redirects back. In every other case (no panel session, no permission, panel down, app login failed) the answer
//    is "pass through" and the request reaches the app's own login page unchanged. API keys / passwords never
//    reach the browser.
//  * Jellyfin keeps its own login; the owner gets a one-click page (/__sso on the Jellyfin host); other users sign in
//    with their Jellyfin password / Quick Connect (an OIDC provider for the 9p4 SSO plugin is in oidc.js).
const crypto = require('crypto');
const DB = require('./db');
const P = require('./perms');
const SET = require('./settings');
const U = require('./util');

const E = process.env;
const COOKIE = 'sm_sso';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const up = (env, def) => String(E[env] || def).replace(/\/+$/, '');

// id, label, description, icon, host prefix, upstream, native session cookie(s), relay kind
const SERVICES = [
  { id: 'jellyfin', name: 'Jellyfin', desc: 'تماشای فیلم و سریال', icon: '🎞️', host: 'jellyfin', up: up('JELLYFIN_API', 'http://jellyfin:8096'), cookies: [], relay: 'jellyfin', ownerOnly: true },
  { id: 'seerr', name: 'Seerr', desc: 'درخواست فیلم و سریال', icon: '🎟️', host: 'seerr', up: up('SEERR_URL', 'http://jellyseerr:5055'), cookies: ['connect.sid'], relay: 'seerr', ownerOnly: true },
  { id: 'radarr', name: 'Radarr', desc: 'مدیریت فیلم‌ها', icon: '🎬', host: 'radarr', up: up('RADARR_URL', 'http://radarr:7878'), cookies: ['RadarrAuth'], relay: 'arr' },
  { id: 'sonarr', name: 'Sonarr', desc: 'مدیریت سریال‌ها', icon: '📺', host: 'sonarr', up: up('SONARR_URL', 'http://sonarr:8989'), cookies: ['SonarrAuth'], relay: 'arr' },
  { id: 'prowlarr', name: 'Prowlarr', desc: 'ایندکسرها', icon: '🧭', host: 'prowlarr', up: up('PROWLARR_URL', 'http://prowlarr:9696'), cookies: ['ProwlarrAuth'], relay: 'arr' },
  { id: 'bazarr', name: 'Bazarr', desc: 'زیرنویس‌ها', icon: '💬', host: 'bazarr', up: up('BAZARR_URL', 'http://bazarr:6767'), cookies: ['session'], relay: 'bazarr' },
  { id: 'qbit', name: 'qBittorrent', desc: 'کلاینت تورنت', icon: '⬇️', host: 'qbittorrent', up: up('QBIT_URL', 'http://qbittorrent:8080'), cookies: ['QBT_SID_8080'], relay: 'qbit', hostHeader: true },
];
const BY_ID = Object.fromEntries(SERVICES.map((s) => [s.id, s]));
const permOf = (s) => `svc.${s.id}`;
const SVC_PERMS = SERVICES.map((s) => [permOf(s), `🔑 ورود به ${s.name}`]);

// ---------------- cookie plumbing ----------------
function cookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {} } } return o; }
const hostOf = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const domains = () => [SET.get('sso.public_domain'), SET.get('sso.lan_domain')].map((d) => String(d || '').toLowerCase()).filter(Boolean);
// parent domain the SSO cookie is scoped to for this request host (null = not one of ours, e.g. a raw IP)
function cookieDomain(host) { for (const d of domains()) if (host === d || host.endsWith('.' + d)) return d; return null; }
const enabled = () => SET.get('sso.enabled') === true && domains().length > 0;

function ssoCookie(req, value, maxAge) {
  const d = cookieDomain(hostOf(req)); if (!d) return null;
  return `${COOKIE}=${value}; Domain=${d}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
// called on login / when the launcher is opened: bind a fresh SSO token to the panel session
function issue(req, sessId) {
  if (!enabled()) return null;
  const tok = crypto.randomBytes(32).toString('base64url');
  DB.run('INSERT INTO sso_tokens(h,sess,created) VALUES(?,?,?)', sha(tok), sha(sessId), Date.now());
  if (Math.random() < 0.05) DB.run('DELETE FROM sso_tokens WHERE sess NOT IN (SELECT id FROM panel_sessions)');
  return ssoCookie(req, tok, SET.get('panel.session_hours') * 3600);
}
const clear = (req) => ssoCookie(req, '', 0);
function revokeFor(sessId) { if (sessId) DB.run('DELETE FROM sso_tokens WHERE sess=?', sha(sessId)); }

// the panel user behind an sm_sso cookie, or null
function whoami(req) {
  const t = cookies(req)[COOKIE]; if (!t) return null;
  const r = DB.one('SELECT s.id, s.uid, s.username, s.expires FROM sso_tokens t JOIN panel_sessions s ON s.id=t.sess WHERE t.h=?', sha(t));
  if (!r || r.expires < Date.now()) return null;
  if (!P.isOwner(r.uid) && !P.allowed(r.uid)) return null;
  const acc = DB.one('SELECT disabled FROM panel_accounts WHERE username=?', r.username);
  if (!acc || acc.disabled) return null;
  return r;
}
const mayUse = (uid, s) => P.can(uid, permOf(s));

// ---------------- server-side login to the apps (native auth, session cookie handed to the browser) ----------------
const failedAt = {};
const secret = (name) => E[name] || '';
function creds(s) {
  const id = s.id.toUpperCase();
  if (s.id === 'qbit') return { user: E.QBIT_USER || '', pass: E.QBIT_PASS || '' };
  const user = E[`SSO_${id}_USER`] || E.SSO_SVC_USER || E.PANEL_OWNER_USER || E.JELLYFIN_USER || '';
  const pass = E[`SSO_${id}_PASS`] || secret(E.SSO_SVC_PASS_ENV || E.PANEL_OWNER_PASS_ENV || 'JELLYFIN_PASS');
  return { user, pass };
}
async function post(url, { form, json, headers = {}, timeout = 10000 } = {}) {
  const h = { ...headers }; let body;
  if (form) { body = new URLSearchParams(form); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
  else if (json) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  return fetch(url, { method: 'POST', body, headers: h, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
}
const setCookies = (res) => (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
const LOGIN = {
  async arr(s, c) {   // Radarr / Sonarr / Prowlarr forms login: 302 to "/" + <App>Auth cookie on success
    const r = await post(`${s.up}/login`, { form: { username: c.user, password: c.pass, rememberMe: 'true' } });
    const loc = r.headers.get('location') || '';
    if (r.status !== 302 || /login/i.test(loc)) throw new Error(`login rejected (${r.status})`);
    return setCookies(r);
  },
  async qbit(s, c) {
    const r = await post(`${s.up}/api/v2/auth/login`, { form: { username: c.user, password: c.pass }, headers: { Referer: s.up } });
    const ck = setCookies(r); const body = r.status === 200 ? await r.text() : '';
    if (!(r.status === 204 || (r.status === 200 && /^ok/i.test(body))) || !ck.length) throw new Error(`login rejected (${r.status})`);
    return ck;
  },
  async bazarr(s, c) {
    const r = await post(`${s.up}/api/system/account?action=login`, { form: { username: c.user, password: c.pass } });
    const ck = setCookies(r); if (r.status !== 204 || !ck.length) throw new Error(`login rejected (${r.status})`);
    return ck;
  },
  async seerr(s, c) {   // Seerr signs in through its Jellyfin account
    const r = await post(`${s.up}/api/v1/auth/jellyfin`, { json: { username: c.user, password: c.pass } });
    const ck = setCookies(r); if (r.status !== 200 || !ck.length) throw new Error(`login rejected (${r.status})`);
    return ck;
  },
};
// Rewrite the app's Set-Cookie headers for the browser: host-only, Path=/, HttpOnly, SameSite=Lax, Secure on HTTPS.
function relayCookies(raw, req) {
  return raw.map((line) => {
    const parts = line.split(';').map((x) => x.trim()); const nv = parts.shift(); if (!nv.includes('=')) return null;
    const keep = parts.filter((p) => /^(max-age|expires)=/i.test(p));
    return [nv, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...keep, ...(isHttps(req) ? ['Secure'] : [])].join('; ');
  }).filter(Boolean);
}
const safePath = (u) => { u = String(u || '/'); if (!u.startsWith('/') || u.startsWith('//') || u.includes('\\') || /[\r\n]/.test(u)) return '/'; return u; };
function stripForce(u) { try { const x = new URL(u, 'http://x'); x.searchParams.delete('smsso'); const q = x.searchParams.toString(); return x.pathname + (q ? '?' + q : '') + x.hash; } catch { return '/'; } }

// forward_auth target. 2xx = "let the request through to the app unchanged" (native login); 302 = signed in.
function pass(res) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
async function enter(req, res, query) {
  try {
    const s = BY_ID[query.svc];
    if (!s || !enabled()) return pass(res);
    const who = whoami(req);
    if (!who || !mayUse(who.uid, s)) return pass(res);
    if (s.ownerOnly && !P.isOwner(who.uid)) return pass(res);   // Seerr/Jellyfin sessions are per person: do not give others the owner's
    const c = creds(s); if (!c.user || !c.pass) return pass(res);
    if (failedAt[s.id] && Date.now() - failedAt[s.id] < 120000) return pass(res);   // do not hammer a login that is failing
    let raw;
    try { raw = await LOGIN[s.relay](s, c); failedAt[s.id] = 0; }
    catch (e) { failedAt[s.id] = Date.now(); U.log('warn', `sso ${s.id}: ${U.redact(e.message)}`); return pass(res); }
    const out = relayCookies(raw, req);
    out.push(`sm_try_${s.id}=1; Path=/; Max-Age=30; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);   // loop guard
    P.audit(who.uid, 'sso', 'enter', s.id);
    res.writeHead(302, { 'Set-Cookie': out, Location: safePath(stripForce(req.headers['x-forwarded-uri'] || '/')), 'Cache-Control': 'no-store' });
    return res.end();
  } catch (e) { U.log('warn', 'sso enter: ' + U.redact(e.message)); return pass(res); }
}

// ---------------- Jellyfin one-click (owner): page served on the Jellyfin host at /__sso ----------------
const clientBase = (s, req) => `${isHttps(req) ? 'https' : 'http'}://${hostOf(req)}`;
async function jellyfinPage(req, res) {
  const html = (body, script) => {
    const b = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>seemore</title><body style="font-family:sans-serif;text-align:center;padding:3em;background:#111;color:#eee">${body}${script ? `<script>${script}</script>` : ''}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
    res.end(b);
  };
  const s = BY_ID.jellyfin; const toLogin = (msg) => html(`<p>${msg}</p><p><a style="color:#8cf" href="/web/">ورود با نام کاربری و رمز Jellyfin</a></p>`, 'setTimeout(function(){location.replace("/web/")},2500)');
  try {
    const who = whoami(req);
    if (!enabled() || !who || !mayUse(who.uid, s)) return toLogin('ورود یک‌کلیکی ممکن نیست؛ با نام کاربری و رمز وارد شوید.');
    if (!P.isOwner(who.uid) && oidcEnabled()) { res.writeHead(302, { Location: '/__oidc', 'Cache-Control': 'no-store' }); return res.end(); }   // other users: OIDC sign-in to their own account
    if (!P.isOwner(who.uid)) return toLogin('ورود یک‌کلیکی Jellyfin فقط برای مالک است؛ با نام کاربری و رمز خودتان وارد شوید.');
    const c = creds(s); if (!c.user || !c.pass) return toLogin('ورود یک‌کلیکی تنظیم نشده است.');
    if (failedAt.jellyfin && Date.now() - failedAt.jellyfin < 120000) return toLogin('ورود یک‌کلیکی موقتاً غیرفعال است.');
    const auth = 'MediaBrowser Client="seemore-sso", Device="browser", DeviceId="seemore-sso-' + sha(req.headers['user-agent'] || '').slice(0, 12) + '", Version="1.0"';
    const r = await post(`${s.up}/Users/AuthenticateByName`, { json: { Username: c.user, Pw: c.pass }, headers: { Authorization: auth } });
    if (r.status !== 200) { failedAt.jellyfin = Date.now(); U.log('warn', `sso jellyfin: login rejected (${r.status})`); return toLogin('ورود یک‌کلیکی انجام نشد؛ با رمز وارد شوید.'); }
    failedAt.jellyfin = 0;
    const d = await r.json();
    const info = await (await fetch(`${s.up}/System/Info/Public`, { signal: AbortSignal.timeout(8000) })).json();
    const creds_ = { Servers: [{ ManualAddress: clientBase(s, req), manualAddressOnly: true, LastConnectionMode: 2, Id: info.Id, Name: info.ServerName, UserId: d.User.Id, AccessToken: d.AccessToken, DateLastAccessed: Date.now() }] };
    const js = `try{localStorage.setItem('jellyfin_credentials',${JSON.stringify(JSON.stringify(creds_)).replace(/</g, '\\u003c')});}catch(e){}location.replace('/web/');`;
    P.audit(who.uid, 'sso', 'enter', 'jellyfin');
    return html('<p>در حال ورود به Jellyfin…</p>', js);
  } catch (e) { U.log('warn', 'sso jellyfin page: ' + U.redact(e.message)); return toLogin('ورود یک‌کلیکی انجام نشد؛ با رمز وارد شوید.'); }
}

// OIDC guard + first-login provisioning for Jellyfin (called by the OIDC provider before it issues a code).
//  - never lets a non-owner land in a Jellyfin administrator account or in an account named in sso.jellyfin_deny;
//  - an account that does not exist yet is created here (random password, not admin, explicit library list), so the
//    Jellyfin SSO plugin never creates one with "all libraries". Existing accounts are never modified.
// Fails closed: any error means "deny".
const csv = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
let _chain = Promise.resolve();
function jellyfinAccess(username) {
  const run = _chain.then(() => jellyfinAccessOnce(username));
  _chain = run.catch(() => {}); return run;
}
async function jellyfinAccessOnce(username) {
  const s = BY_ID.jellyfin; const c = creds(s); if (!c.user || !c.pass) throw new Error('jellyfin credentials missing');
  const auth = 'MediaBrowser Client="seemore-sso", Device="server", DeviceId="seemore-sso-guard", Version="1.0"';
  const r = await post(`${s.up}/Users/AuthenticateByName`, { json: { Username: c.user, Pw: c.pass }, headers: { Authorization: auth } });
  if (r.status !== 200) throw new Error(`jellyfin login rejected (${r.status})`);
  const tok = (await r.json()).AccessToken; const H = { Authorization: auth + `, Token="${tok}"` };
  const api = async (method, path, json) => {
    const x = await fetch(s.up + path, { method, headers: { ...H, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(10000) });
    if (!x.ok) throw new Error(`jellyfin ${method} ${path.split('?')[0].replace(/[0-9a-f]{32}/g, ':id')} ${x.status}`);
    const t = await x.text(); return t ? JSON.parse(t) : null;
  };
  try {
    const want = String(username).toLowerCase(); const deny = csv(SET.get('sso.jellyfin_deny'));
    const users = await api('GET', '/Users');
    // explicit 1:1 mapping (exact, case-sensitive panel username): existing non-admin account only, never created or modified
    const map = Object.fromEntries(String(SET.get('sso.jellyfin_map') || '').split(',').map((x) => x.split('=').map((y) => y.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
    if (Object.prototype.hasOwnProperty.call(map, username)) {
      const acc = users.find((u) => String(u.Name).toLowerCase() === map[username].toLowerCase());
      return acc && !(acc.Policy && acc.Policy.IsAdministrator) ? { ok: true, created: false, name: acc.Name } : { ok: false, why: 'map-target' };
    }
    if (deny.includes(want)) return { ok: false, why: 'denied-name' };
    const hit = users.find((u) => String(u.Name).toLowerCase() === want);
    if (hit) return hit.Policy && hit.Policy.IsAdministrator ? { ok: false, why: 'admin-name' } : { ok: true, created: false };
    const libs = await api('GET', '/Library/VirtualFolders');
    const named = csv(SET.get('sso.jellyfin_libraries'));
    let ids;
    if (named.length) ids = libs.filter((l) => named.includes(String(l.Name).toLowerCase())).map((l) => l.ItemId);
    else {   // every library that no denied account is restricted to
      const hidden = new Set(); for (const u of users) if (deny.includes(String(u.Name).toLowerCase()) && u.Policy && !u.Policy.EnableAllFolders) (u.Policy.EnabledFolders || []).forEach((f) => hidden.add(f));
      ids = libs.filter((l) => !hidden.has(l.ItemId)).map((l) => l.ItemId);
    }
    const made = await api('POST', '/Users/New', { Name: username, Password: crypto.randomBytes(24).toString('base64url') });
    const pol = { ...made.Policy, IsAdministrator: false, EnableAllFolders: false, EnabledFolders: ids };
    await api('POST', `/Users/${made.Id}/Policy`, pol);
    // the SSO plugin remembers username -> account id; a link left over from a deleted account would make it try to create a duplicate
    try {
      const cfgs = await api('GET', '/sso/OID/Get');
      for (const [prov, cfg] of Object.entries(cfgs || {})) {
        const links = cfg.CanonicalLinks || {}; const k = Object.keys(links).find((x) => x.toLowerCase() === want);
        if (k && cfg.OidSecret) { delete links[k]; await api('POST', `/sso/OID/Add/${encodeURIComponent(prov)}`, cfg); }
      }
    } catch (e) { U.log('warn', 'sso jellyfin: stale link cleanup: ' + U.redact(e.message)); }
    U.log('info', `sso jellyfin: created account for panel user (${ids.length} libraries)`);
    return { ok: true, created: true };
  } finally { fetch(`${s.up}/Sessions/Logout`, { method: 'POST', headers: H, signal: AbortSignal.timeout(5000) }).catch(() => {}); }
}

// ---------------- launcher list (panel API) ----------------
function urlFor(s, req) {
  const host = hostOf(req); const lan = String(SET.get('sso.lan_domain') || '').toLowerCase(); const pub = String(SET.get('sso.public_domain') || '').toLowerCase();
  const useLan = lan && (host === lan || host.endsWith('.' + lan)) || (!pub && lan);
  const base = useLan ? `http://${s.host}.${lan}` : `https://${s.host}.${pub}`;
  return base + (s.id === 'jellyfin' ? '/__sso' : '/?smsso=1');
}
function services(req, uid) {
  if (!enabled() && !(SET.get('sso.public_domain') || SET.get('sso.lan_domain'))) return { enabled: false, services: [] };
  const list = SERVICES.filter((s) => mayUse(uid, s)).map((s) => ({ id: s.id, name: s.name, desc: s.desc, icon: s.icon, url: urlFor(s, req), sso: enabled() ? (s.ownerOnly && !P.isOwner(uid) && !(s.id === 'jellyfin' && oidcEnabled()) ? 'login' : 'auto') : 'login' }));
  return { enabled: enabled(), services: list };
}

// ---------------- Caddy blocks for the service hosts ----------------
// a hung or dead panel must never block the apps: short timeouts, then handle_errors proxies straight to the app
const TRANSPORT = ['\t\ttransport http {', '\t\t\tdial_timeout 2s', '\t\t\tresponse_header_timeout 5s', '\t\t}'];
const strip = 'header_up Cookie "sm_sso=[^;]*;?\\s*" ""';
function renderServices(over = {}) {
  const g = (k) => (k in over ? over[k] : SET.get(k));
  const pub = String(g('sso.public_domain') || ''), lan = String(g('sso.lan_domain') || '');
  if (!pub && !lan) return '';
  const on = g('sso.enabled') === true;
  const api = `${process.env.SELF_HOST || 'media-bot'}:${g('net.api_port')}`;
  const out = ['# Generated by seemore (sso.* settings): reverse proxies for the media services.', '# With SSO on, a browser holding a valid panel SSO cookie is signed in to the app; everyone else gets the app\'s own login.\n'];
  const proxy = (s, ind) => {
    // qBittorrent compares Origin/Referer with the Host header (CSRF): make them agree after the Host rewrite, otherwise browser logins through the proxy are rejected
    const hh = s.hostHeader ? `\n${ind}\theader_up Host {upstream_hostport}\n${ind}\theader_up Origin "^https?://[^/]+" "http://{upstream_hostport}"\n${ind}\theader_up Referer "^https?://[^/]+" "http://{upstream_hostport}"` : '';
    return `${ind}reverse_proxy ${s.up.replace(/^https?:\/\//, '')} {\n${ind}\t${strip}${hh}\n${ind}}`;
  };
  for (const s of SERVICES) {
    for (const [dom, https] of [[pub, true], [lan, false]]) {
      if (!dom) continue;
      const addr = `${https ? '' : 'http://'}${s.host}.${dom}`;
      const lines = [`${addr} {`];
      if (on && s.relay !== 'jellyfin') {
        const ck = s.cookies.map((c) => c.replace(/[.]/g, '\\.')).concat([`sm_try_${s.id}`]).join('|');
        lines.push('\t@sso_force {', '\t\tmethod GET', '\t\tquery smsso=1', '\t\theader_regexp Cookie "(^|;\\s*)sm_sso="', '\t}');
        lines.push('\t@sso_auto {', '\t\tmethod GET', '\t\theader Accept *text/html*', '\t\theader_regexp Cookie "(^|;\\s*)sm_sso="', `\t\tnot header_regexp Cookie "(^|;\\s*)(${ck})="`, '\t}');
        lines.push(`\tforward_auth @sso_force ${api} {`, `\t\turi /sso/enter?svc=${s.id}`, ...TRANSPORT, '\t}');
        lines.push(`\tforward_auth @sso_auto ${api} {`, `\t\turi /sso/enter?svc=${s.id}`, ...TRANSPORT, '\t}');
        lines.push(proxy(s, '\t'));
        lines.push('\thandle_errors {', proxy(s, '\t\t'), '\t}');   // panel/API down: straight to the app's own login
      } else if (on && s.relay === 'jellyfin') {
        lines.push('\thandle /__sso {', '\t\trewrite * /sso/jellyfin', `\t\treverse_proxy ${api}`, '\t}');
        // "Sign in with SeeMore" button target: the plugin provider that matches this host (public = https panel, LAN = http panel)
        lines.push('\thandle /__oidc {', `\t\tredir * /sso/OID/start/${https ? 'seemore' : 'seemore-lan'} 302`, '\t}');
        lines.push('\thandle {', proxy(s, '\t\t'), '\t}');
      } else lines.push(proxy(s, '\t'));
      lines.push('}\n');
      out.push(lines.join('\n'));
    }
  }
  return out.join('\n');
}

// ---------------- HTTP entry (called from api/server.js before routing) ----------------
const OIDC = () => require('./oidc');
const oidcEnabled = () => enabled() && SET.get('sso.oidc') === true;
const claims = (p) => p === '/sso/enter' || p === '/sso/jellyfin' || OIDC().claims(p);
async function handle(req, res, pathname, u) {
  if (pathname === '/sso/enter') return enter(req, res, Object.fromEntries(u.searchParams));
  if (pathname === '/sso/jellyfin') return jellyfinPage(req, res);
  return OIDC().handle(req, res, pathname, u, module.exports);
}
module.exports = { jellyfinAccess, oidcEnabled, SERVICES, SVC_PERMS, BY_ID, COOKIE, enabled, issue, clear, revokeFor, whoami, mayUse, services, renderServices, claims, handle, cookieDomain, hostOf, cookies, domains };
