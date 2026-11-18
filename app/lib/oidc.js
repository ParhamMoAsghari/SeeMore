'use strict';
// Minimal OpenID Connect provider for the seemore panel (authorization-code flow + PKCE, RS256 id_tokens).
// Intended for the 9p4 "SSO Authentication" Jellyfin plugin (or any OIDC relying party). It is only reachable on the
// panel host; a user needs the panel SSO cookie (or logs in on the small form below) AND the svc.<client> permission.
//   discovery  /.well-known/openid-configuration      jwks  /oidc/jwks
//   authorize  /oidc/authorize   token  /oidc/token   userinfo  /oidc/userinfo
// State: /state/oidc.json (chmod 600): RSA signing key + registered clients {id, secret (hash), redirect URIs, perm}.
// Authorization codes are one-time, 60 s, kept in memory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./perms');
const SET = require('./settings');
const U = require('./util');

const FILE = process.env.OIDC_FILE || path.join(path.dirname(process.env.DB_FILE || '/state/bot.db'), 'oidc.json');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
let ST = null;
function load() {
  if (ST) return ST;
  try { ST = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { ST = null; }
  if (!ST || !ST.key) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    ST = { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), kid: crypto.randomBytes(6).toString('hex'), clients: ST && ST.clients || {} };
    save();
  }
  return ST;
}
function save() { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(ST), { mode: 0o600 }); const fd = fs.openSync(t, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(t, FILE); try { fs.chmodSync(FILE, 0o600); } catch {} }
// register / update a client; returns the plain secret ONCE when it was generated
function registerClient({ id, redirects, perm, secret }) {
  load(); const plain = secret || crypto.randomBytes(24).toString('base64url');
  ST.clients[id] = { id, redirects: redirects || [], perm: perm || null, secret: sha256(plain).toString('hex') }; save();
  return { id, secret: plain };
}
const clients = () => Object.values(load().clients).map((c) => ({ id: c.id, redirects: c.redirects, perm: c.perm }));
const removeClient = (id) => { load(); delete ST.clients[id]; save(); };

const issuerOf = (req) => { const f = SET.get('sso.oidc_issuer'); if (f) return String(f).replace(/\/+$/, ''); const h = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(); return `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()}://${h}`; };
const jwk = () => { const k = crypto.createPublicKey(load().key).export({ format: 'jwk' }); return { ...k, use: 'sig', alg: 'RS256', kid: load().kid }; };
function sign(payload) {
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: load().kid })); const b = b64u(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${b}`), load().key);
  return `${h}.${b}.${b64u(sig)}`;
}
const codes = new Map();    // code -> {client, uid, username, redirect, challenge, nonce, scope, exp}
const tokens = new Map();   // access token hash -> {uid, username, client, exp}
const sweep = () => { const n = Date.now(); for (const [k, v] of codes) if (v.exp < n) codes.delete(k); for (const [k, v] of tokens) if (v.exp < n) tokens.delete(k); };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const b = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-store', ...extra }); res.end(b);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function readForm(req, limit = 8192) {
  return new Promise((resolve, reject) => { let n = 0; const ch = []; req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else ch.push(c); }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(ch).toString('utf8'))))); req.on('error', reject); });
}
const redirectTo = (res, loc, extra = {}) => { res.writeHead(302, { Location: loc, 'Cache-Control': 'no-store', ...extra }); res.end(); };
const errRedirect = (res, redirect, state, error, desc) => { const u = new URL(redirect); u.searchParams.set('error', error); if (desc) u.searchParams.set('error_description', desc); if (state) u.searchParams.set('state', state); redirectTo(res, u.toString()); };

function discovery(req) {
  const i = issuerOf(req);
  return { issuer: i, authorization_endpoint: `${i}/oidc/authorize`, token_endpoint: `${i}/oidc/token`, userinfo_endpoint: `${i}/oidc/userinfo`, jwks_uri: `${i}/oidc/jwks`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'], code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'preferred_username', 'name', 'groups', 'roles'] };
}

async function authorize(req, res, q, SSO) {
  const c = load().clients[q.client_id];
  if (!c || !c.redirects.includes(q.redirect_uri)) return send(res, 400, 'unknown client or redirect_uri', 'text/plain; charset=utf-8');
  if (q.response_type !== 'code') return errRedirect(res, q.redirect_uri, q.state, 'unsupported_response_type');
  if (q.code_challenge && q.code_challenge_method !== 'S256') return errRedirect(res, q.redirect_uri, q.state, 'invalid_request', 'only S256');
  let who = SSO.whoami(req);
  if (!who) return toPanelLogin(res, q);
  if (c.perm && !P.can(who.uid, c.perm)) { P.audit(who.uid, 'sso', 'oidc_denied', c.id); return errRedirect(res, q.redirect_uri, q.state, 'access_denied', 'no permission'); }
  if ((c.id === 'jellyfin' || c.perm === 'svc.jellyfin') && !P.isOwner(who.uid)) {   // never an admin / denied account; create the account on first login
    let g; try { g = await SSO.jellyfinAccess(who.username); } catch (e) { U.log('warn', 'oidc jellyfin guard: ' + U.redact(e.message)); g = { ok: false, why: 'error' }; }
    if (!g.ok) { P.audit(who.uid, 'sso', 'oidc_denied', 'jellyfin-' + g.why); return errRedirect(res, q.redirect_uri, q.state, 'access_denied', 'account not allowed'); }
    if (g.name) who = { ...who, username: g.name };   // mapped account name
  }
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, { client: c.id, uid: who.uid, username: who.username, redirect: q.redirect_uri, challenge: q.code_challenge || null, nonce: q.nonce || null, scope: q.scope || 'openid', exp: Date.now() + 60000 });
  P.audit(who.uid, 'sso', 'oidc_authorize', c.id);
  const u = new URL(q.redirect_uri); u.searchParams.set('code', code); if (q.state) u.searchParams.set('state', q.state);
  return redirectTo(res, u.toString());
}
// Sign-in is the panel's normal login page: send the browser to /login?next=<this authorize URL>; the panel UI returns here after login.
function toPanelLogin(res, q) {
  const u = new URL('/oidc/authorize', 'http://x'); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return redirectTo(res, '/login?next=' + encodeURIComponent(u.pathname + u.search));
}
async function token(req, res) {
  const f = await readForm(req);
  let cid = f.client_id; let sec = f.client_secret;
  const ba = /^Basic (.+)$/.exec(req.headers.authorization || ''); if (ba) { const [a, b] = Buffer.from(ba[1], 'base64').toString().split(':'); cid = decodeURIComponent(a); sec = decodeURIComponent(b || ''); }
  const c = load().clients[cid];
  const bad = (e, code = 400) => send(res, code, { error: e });
  if (!c) return bad('invalid_client', 401);
  if (sec) { const h = sha256(sec).toString('hex'); if (h.length !== c.secret.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c.secret))) return bad('invalid_client', 401); }
  if (f.grant_type !== 'authorization_code') return bad('unsupported_grant_type');
  const a = codes.get(f.code); codes.delete(f.code);
  if (!a || a.exp < Date.now() || a.client !== c.id || a.redirect !== f.redirect_uri) return bad('invalid_grant');
  if (a.challenge) { if (!f.code_verifier || b64u(sha256(f.code_verifier)) !== a.challenge) return bad('invalid_grant'); }
  else if (!sec) return bad('invalid_client', 401);   // public client must use PKCE
  const now = Math.floor(Date.now() / 1000); const iss = issuerOf(req);
  const owner = P.isOwner(a.uid);
  const claims = { preferred_username: a.username, name: a.username, groups: owner ? ['admin', 'user'] : ['user'], roles: owner ? ['admin', 'user'] : ['user'] };
  const id_token = sign({ iss, sub: a.username, aud: c.id, iat: now, exp: now + 3600, auth_time: now, ...(a.nonce ? { nonce: a.nonce } : {}), ...claims });
  const at = crypto.randomBytes(24).toString('base64url'); tokens.set(sha256(at).toString('hex'), { uid: a.uid, username: a.username, client: c.id, exp: Date.now() + 3600000 });
  sweep();
  return send(res, 200, { access_token: at, token_type: 'Bearer', expires_in: 3600, id_token, scope: a.scope });
}
function userinfo(req, res) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); const t = m && tokens.get(sha256(m[1]).toString('hex'));
  if (!t || t.exp < Date.now() || !(P.isOwner(t.uid) || P.allowed(t.uid))) return send(res, 401, { error: 'invalid_token' }, 'application/json', { 'WWW-Authenticate': 'Bearer' });
  const owner = P.isOwner(t.uid);
  return send(res, 200, { sub: t.username, preferred_username: t.username, name: t.username, groups: owner ? ['admin', 'user'] : ['user'], roles: owner ? ['admin', 'user'] : ['user'] });
}
const CLAIMED = new Set(['/.well-known/openid-configuration', '/oidc/.well-known/openid-configuration', '/oidc/jwks', '/oidc/authorize', '/oidc/token', '/oidc/userinfo', '/oidc/login']);
const claims = (p) => CLAIMED.has(p);
async function handle(req, res, pathname, u, SSO) {
  try {
    if (!SSO.oidcEnabled()) return send(res, 404, { error: 'not found' });
    if (pathname.endsWith('/.well-known/openid-configuration')) return send(res, 200, discovery(req), 'application/json; charset=utf-8', { 'Cache-Control': 'public, max-age=300' });
    if (pathname === '/oidc/jwks') return send(res, 200, { keys: [jwk()] });
    if (pathname === '/oidc/authorize' && req.method === 'GET') return await authorize(req, res, Object.fromEntries(u.searchParams), SSO);
    if (pathname === '/oidc/token' && req.method === 'POST') return await token(req, res);
    if (pathname === '/oidc/userinfo') return userinfo(req, res);
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) { U.log('warn', 'oidc: ' + U.redact(e.message)); return send(res, 500, { error: 'server_error' }); }
}
module.exports = { claims, handle, registerClient, removeClient, clients, discovery, jwk };
