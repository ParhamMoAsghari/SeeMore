'use strict';
// seemore HTTP API (/api/v1, domain operations) + the React panel (static files from PUBLIC_DIR).
// Interfaces (panel, Telegram/Bale bot) are clients of the same core (core.call); this file
// only does HTTP concerns: auth/session/CSRF, routing, validation of the transport, SSE, static files.
const fs = require('fs');
const path = require('path');
const http = require('http');
const core = require('../core');
const P = require('../perms');
const SET = require('../settings');
const U = require('../util');
const auth = require('./auth');
const sse = require('./sse');
const routes = require('./routes');

const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, '..', '..', 'public');
const COOKIE = 'sm_session';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.yaml': 'text/yaml; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

function clientIp(req) {
  const ra = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const priv = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/.test(ra);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return priv && xff.length ? xff[xff.length - 1] : ra;   // Caddy appends the real client as the last hop
}
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function cookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function setCookie(res, req, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`);
}
function headers(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}
function json(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length }); res.end(b); }
function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!size) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
// same-origin check for state-changing requests (in addition to the CSRF token)
function sameOrigin(req) {
  const o = req.headers.origin || req.headers.referer; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/\0/g, '');
  let file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(path.resolve(PUBLIC))) { res.writeHead(400); return res.end(); }
  let st = null; try { st = fs.statSync(file); } catch {}
  if (!st || st.isDirectory()) { file = path.join(PUBLIC, 'index.html'); try { st = fs.statSync(file); } catch { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('panel not built'); } }
  const ext = path.extname(file);
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  headers(req, res);
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }
  const ip = clientIp(req);
  const sid = cookies(req)[COOKIE];
  const ctx = { req, res, u, ip, query: Object.fromEntries(u.searchParams), body: {}, sess: null };
  try {
    // ---- public endpoints ----
    if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
      const b = await readBody(req, 4096);
      const r = await auth.login(b.username, b.password, { ip, ua: req.headers['user-agent'] });
      if (!r.ok) return json(res, r.locked ? 429 : 401, { error: r.locked ? 'locked' : 'invalid credentials', retryAfter: r.locked || undefined });
      setCookie(res, req, r.sid, SET.get('panel.session_hours') * 3600);
      return json(res, 200, { ok: true, csrf: r.csrf, ...(await routes.me(r.uid, r.username)) });
    }
    if (pathname === '/api/v1/openapi.yaml') { const f = path.join(__dirname, 'openapi.yaml'); res.writeHead(200, { 'Content-Type': MIME['.yaml'] }); return fs.createReadStream(f).pipe(res); }
    // ---- session required below ----
    const sess = auth.session(sid);
    if (pathname === '/api/v1/health' && !sess) return json(res, 200, { ok: true });   // liveness only
    if (!sess) return json(res, 401, { error: 'not authenticated' });
    ctx.sess = sess;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const tok = String(req.headers['x-csrf-token'] || '');
      if (!sameOrigin(req) || !tok || tok !== sess.csrf) return json(res, 403, { error: 'csrf' });
      ctx.body = await readBody(req);
    }
    if (pathname === '/api/v1/auth/logout' && req.method === 'POST') { auth.logout(sid); setCookie(res, req, '', 0); return json(res, 200, { ok: true }); }
    if (pathname === '/api/v1/auth/session' || pathname === '/api/v1/me') return json(res, 200, { csrf: sess.csrf, ...(await routes.me(sess.uid, sess.username)) });
    if (pathname === '/api/v1/events') return sse.stream(req, res, sess.uid);
    const hit = routes.match(req.method, pathname);
    if (!hit) return json(res, 404, { error: 'not found' });
    ctx.params = hit.params;
    const out = await hit.route.fn(ctx, sess.uid);
    if (out === routes.HANDLED) return;
    return json(res, hit.route.status || 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    const status = e.status || (e.user ? 400 : e.svc ? 502 : 500);
    if (status >= 500) U.log('warn', `api ${req.method} ${pathname}: ${U.redact(e.message)}`);
    const body = { error: String(e.message || e).slice(0, 300) };
    if (e.needsConfirm) Object.assign(body, { needsConfirm: true, plan: e.plan });
    if (!res.headersSent) return json(res, status, body);
    try { res.end(); } catch {}
  }
}

let server = null;
function start() {
  const port = Number(SET.get('net.api_port')) || 3002;
  auth.syncOwner().catch((e) => U.log('warn', 'panel owner sync: ' + e.message));
  setInterval(() => auth.syncOwner().catch(() => {}), 600000).unref();
  server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { json(res, 500, { error: 'internal' }); } catch {} U.log('error', 'api crash: ' + e.message); }); });
  server.keepAliveTimeout = 65000;
  server.listen(port, () => U.log('info', `seemore API + panel on :${port}`));
  sse.start();
  return server;
}
module.exports = { start, handle, clientIp };
