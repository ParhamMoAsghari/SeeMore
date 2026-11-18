'use strict';
// SSO end-to-end test. Runs against the live stack from inside the seemore container:
//   docker exec -i media-bot node - < app/tests/sso_e2e.js
// It talks to the panel API directly and to every service THROUGH Caddy (Host header = service host), creates two
// temporary panel users and removes them again. Prints one line per check and exits non-zero on any failure.
// Never prints credentials or cookie values.
const http = require('http');
const E = process.env;
const API = { host: 'media-bot', port: Number(E.API_PORT || 3002) };
const CADDY = { host: E.SSO_TEST_CADDY || 'caddy', port: 80 };
const LAN = E.SSO_TEST_LAN || 'example.lan';
const PANEL_HOST = `panel.${LAN}`;
const SERVICES = ['jellyfin', 'seerr', 'radarr', 'sonarr', 'prowlarr', 'bazarr', 'qbit'];
const HOST = { qbit: 'qbittorrent' };
const hostOf = (id) => `${HOST[id] || id}.${LAN}`;
let pass = 0; let failN = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log(`PASS ${name}`); } else { failN++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`); } };

function req(target, { method = 'GET', path = '/', host, headers = {}, body, json, jar } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host, 'User-Agent': 'sso-e2e', ...headers };
    if (jar && jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = null;
    if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    else if (body) { payload = new URLSearchParams(body).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const r = http.request({ ...target, method, path, headers: h, timeout: 20000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'] || [];
        if (jar) for (const line of sc) { const [nv, ...attrs] = line.split(';'); const i = nv.indexOf('='); const k = nv.slice(0, i).trim(); const v = nv.slice(i + 1).trim(); if (/max-age=0/i.test(attrs.join(';')) || v === '') jar.delete(k); else jar.set(k, v); }
        resolve({ status: res.statusCode, headers: res.headers, setCookie: sc, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
    if (payload) r.write(payload); r.end();
  });
}
const api = (jar, method, path, json, csrf) => req(API, { method, path: '/api/v1' + path, host: PANEL_HOST, json, jar, headers: csrf ? { 'X-CSRF-Token': csrf } : {} });
const names = (sc) => sc.map((l) => l.split('=')[0]);
const NAV = { Accept: 'text/html,application/xhtml+xml' };
// authenticated probes: [path, expectedStatusWhenLoggedIn]
const PROBE = { radarr: '/api/v3/system/status', sonarr: '/api/v3/system/status', prowlarr: '/api/v1/system/status', bazarr: '/api/system/status', qbit: '/api/v2/app/version', seerr: '/api/v1/auth/me', jellyfin: '/Users/Me' };
// "is this cookie jar signed in to the app?" (the *arr apps and Bazarr only accept the API key on /api, the UI shell tells)
const anonShell = {};
async function signedIn(id, host, jar) {
  if (['radarr', 'sonarr', 'prowlarr'].includes(id)) { const r = await req(CADDY, { path: '/', host, headers: NAV, jar }); return r.status === 200; }
  if (id === 'bazarr') { const r = await req(CADDY, { path: '/', host, headers: NAV, jar }); return r.status === 200 && r.text !== (anonShell.bazarr ??= (await req(CADDY, { path: '/', host, headers: NAV })).text); }
  const r = await req(CADDY, { path: PROBE[id], host, jar }); return r.status === 200;
}

async function panelLogin(username, password) {
  const jar = new Map();
  const r = await api(jar, 'POST', '/auth/login', { username, password });
  return { jar, status: r.status, csrf: (JSON.parse(r.text || '{}') || {}).csrf, setCookie: r.setCookie };
}
const ssoJar = (j) => new Map([...j].filter(([k]) => k === 'sm_sso'));

(async () => {
  const ownerUser = E.PANEL_OWNER_USER || E.JELLYFIN_USER; const ownerPass = E[E.PANEL_OWNER_PASS_ENV || 'JELLYFIN_PASS'];
  const owner = await panelLogin(ownerUser, ownerPass);
  ok(owner.status === 200, 'panel login (owner)');
  const sso = owner.setCookie.find((c) => c.startsWith('sm_sso='));
  ok(!!sso && /Domain=example\.lan/i.test(sso) && /HttpOnly/i.test(sso) && /SameSite=Lax/i.test(sso), 'sm_sso cookie: parent domain, HttpOnly, SameSite=Lax');
  const https = await req(API, { method: 'POST', path: '/api/v1/auth/login', host: 'panel.example.com', headers: { 'X-Forwarded-Proto': 'https' }, json: { username: ownerUser, password: ownerPass } });
  const sso2 = https.setCookie.find((c) => c.startsWith('sm_sso='));
  ok(!!sso2 && /Domain=example\.com/i.test(sso2) && /Secure/i.test(sso2), 'sm_sso cookie on HTTPS: Domain=public domain + Secure');
  const sess = owner.setCookie.find((c) => c.startsWith('sm_session='));
  ok(!!sess && !/Domain=/i.test(sess), 'panel session cookie stays host-only');

  // temporary users: A = every service, B = no service, C = only Radarr
  const T = { a: { uid: 990000001, name: 'ssotest_a', perms: SERVICES.map((s) => 'svc.' + s).concat(['library']) }, b: { uid: 990000002, name: 'ssotest_b', perms: ['library'] }, c: { uid: 990000003, name: 'ssotest_c', perms: ['svc.radarr'] } };
  const pw = require('crypto').randomBytes(12).toString('base64url') + 'Aa1';
  try {
    for (const t of Object.values(T)) {
      let r = await api(owner.jar, 'POST', '/users', { uid: t.uid, name: t.name, perms: t.perms, expires: null }, owner.csrf);
      ok(r.status === 201 || r.status === 200, `grant ${t.name}`, String(r.status));
      r = await api(owner.jar, 'PUT', `/panel-accounts/${t.name}`, { uid: t.uid, password: pw }, owner.csrf);
      ok(r.status === 200, `panel account ${t.name}`, String(r.status));
      t.s = await panelLogin(t.name, pw); ok(t.s.status === 200, `panel login ${t.name}`);
    }

    // ---- launcher visibility (server-side filter) ----
    const list = async (who) => { const r = await api(who.jar, 'GET', '/sso/services'); return JSON.parse(r.text).services.map((s) => s.id).sort(); };
    const all = SERVICES.slice().sort();
    ok(JSON.stringify(await list(owner)) === JSON.stringify(all), 'launcher: owner sees all services');
    ok(JSON.stringify(await list(T.a.s)) === JSON.stringify(all), 'launcher: user with all svc.* sees all');
    ok((await list(T.b.s)).length === 0, 'launcher: user without any svc.* sees no service link');
    ok(JSON.stringify(await list(T.c.s)) === '["radarr"]', 'launcher: user with only svc.radarr sees only Radarr');
    const raw = (await api(T.c.s.jar, 'GET', '/sso/services')).text;
    ok(!/sonarr|qbittorrent|prowlarr|bazarr|seerr|jellyfin/i.test(raw), 'launcher: no URL of an unpermitted service in the response');

    // ---- per service ----
    for (const id of SERVICES) {
      const host = hostOf(id);
      const probe = PROBE[id];
      const anon = await req(CADDY, { path: probe, host });
      ok([401, 403].includes(anon.status), `${id}: (d) no panel session + no app login -> denied`, String(anon.status));
      const anonSso = await req(CADDY, { path: '/?smsso=1', host, headers: NAV });
      ok(!names(anonSso.setCookie).some((n) => /Auth|SID|session|connect\.sid/.test(n)), `${id}: (d) /?smsso=1 without panel cookie creates no app session`);
      // (a) native login without panel session
      const nj = new Map(); let nr;
      if (id === 'qbit') nr = await req(CADDY, { method: 'POST', path: '/api/v2/auth/login', host, body: { username: E.QBIT_USER, password: E.QBIT_PASS }, headers: { Origin: `http://${host}`, Referer: `http://${host}/` }, jar: nj });
      else if (id === 'bazarr') nr = await req(CADDY, { method: 'POST', path: '/api/system/account?action=login', host, body: { username: ownerUser, password: ownerPass }, jar: nj });
      else if (id === 'seerr') nr = await req(CADDY, { method: 'POST', path: '/api/v1/auth/jellyfin', host, json: { username: ownerUser, password: ownerPass }, jar: nj });
      else if (id === 'jellyfin') nr = await req(CADDY, { method: 'POST', path: '/Users/AuthenticateByName', host, json: { Username: ownerUser, Pw: ownerPass }, headers: { Authorization: 'MediaBrowser Client="sso-e2e", Device="t", DeviceId="sso-e2e", Version="1"' }, jar: nj });
      else nr = await req(CADDY, { method: 'POST', path: '/login', host, body: { username: ownerUser, password: ownerPass, rememberMe: 'true' }, jar: nj });
      ok([200, 204, 302].includes(nr.status) && (id === 'jellyfin' ? nr.status === 200 : nj.size > 0), `${id}: (a) native username/password login works without panel session`, String(nr.status));
      if (id === 'jellyfin') { const tok = JSON.parse(nr.text).AccessToken; const me = await req(CADDY, { path: probe, host, headers: { Authorization: `MediaBrowser Token="${tok}"` } }); ok(me.status === 200, 'jellyfin: password login yields a working session', String(me.status)); }
      else ok(await signedIn(id, host, nj), `${id}: native session works`);

      if (id === 'jellyfin') continue;
      // (b) with panel session + permission
      for (const [label, who, expectSso] of [['owner', owner, true], ['user A (all)', T.a.s, !['seerr'].includes(id)], ['user C (radarr only)', T.c.s, id === 'radarr'], ['user B (none)', T.b.s, false]]) {
        const jar = ssoJar(who.jar);
        const r = await req(CADDY, { path: '/?smsso=1', host, headers: NAV, jar });
        const hasSession = names(r.setCookie).some((n) => !/^sm_try_/.test(n));
        const owned = id === 'seerr' ? who === owner : true;
        const should = expectSso && owned;
        ok(should ? (r.status === 302 && r.headers.location === '/' && hasSession) : !hasSession, `${id}: ${label}: ${should ? '(b) SSO signs in without extra login' : '(c) no permission -> native login, no app session'}`, `${r.status} ${r.headers.location || ''} ${names(r.setCookie).join(',')}`);
        if (should) {
          const aj = new Map(); for (const l of r.setCookie) { const [nv] = l.split(';'); const i = nv.indexOf('='); aj.set(nv.slice(0, i), nv.slice(i + 1)); }
          ok(await signedIn(id, host, aj), `${id}: ${label}: SSO session is accepted by the app`);
        } else {
          ok(!(await signedIn(id, host, ssoJar(who.jar))), `${id}: ${label}: panel cookie alone gives no app access`);
        }
      }
      // the sm_sso cookie must not reach the app (stripped by Caddy): the app sees no unknown cookie -> indirect: request still works natively
    }

    // ---- Jellyfin one-click page ----
    {
      const host = hostOf('jellyfin');
      const r = await req(CADDY, { path: '/__sso', host, jar: ssoJar(owner.jar) });
      const m = /jellyfin_credentials',("(?:\\.|[^"\\])*")\)/.exec(r.text);
      ok(r.status === 200 && !!m, 'jellyfin: owner one-click page carries credentials');
      if (m) { const c = JSON.parse(JSON.parse(m[1])); const me = await req(CADDY, { path: '/Users/Me', host, headers: { Authorization: `MediaBrowser Token="${c.Servers[0].AccessToken}"` } }); ok(me.status === 200, 'jellyfin: one-click session works'); }
      const rb = await req(CADDY, { path: '/__sso', host, jar: ssoJar(T.b.s.jar) });
      ok(!/jellyfin_credentials/.test(rb.text) && rb.status === 200, 'jellyfin: user without svc.jellyfin gets no session (native login page)');
      const ra = await req(CADDY, { path: '/__sso', host, jar: ssoJar(T.a.s.jar) });
      ok(!/jellyfin_credentials/.test(ra.text), "jellyfin: non-owner never receives the owner's session");
      const rn = await req(CADDY, { path: '/__sso', host });
      ok(!/jellyfin_credentials/.test(rn.text), 'jellyfin: no panel cookie -> no session');
    }
    // ---- OIDC provider (for the Jellyfin SSO plugin) ----
    {
      const crypto = require('crypto');
      const DB = require('/app/lib/db'); DB.open(E.DB_FILE || '/state/bot.db'); const SET = require('/app/lib/settings'); SET.start();
      const was = SET.get('sso.oidc'); SET.set('sso.oidc', true, null); await new Promise((r) => setTimeout(r, 6000));
      const O = (path, o = {}) => req(API, { host: PANEL_HOST, path, ...o });
      try {
        const cl = JSON.parse((await api(owner.jar, 'PUT', '/sso/oidc/clients/ssotest', { redirects: ['http://localhost/cb'], perm: 'svc.jellyfin' }, owner.csrf)).text);
        ok(!!cl.secret, 'oidc: client registered (secret returned once)');
        const lst = JSON.parse((await api(owner.jar, 'GET', '/sso/oidc/clients')).text);
        ok(lst.some((c) => c.id === 'ssotest') && !JSON.stringify(lst).includes(cl.secret), 'oidc: client list never contains secrets');
        const d = JSON.parse((await O('/.well-known/openid-configuration')).text);
        ok(d.authorization_endpoint.endsWith('/oidc/authorize') && d.jwks_uri.endsWith('/oidc/jwks') && d.code_challenge_methods_supported.includes('S256'), 'oidc: discovery document');
        const jwks = JSON.parse((await O('/oidc/jwks')).text);
        ok(jwks.keys.length === 1 && jwks.keys[0].kty === 'RSA' && !jwks.keys[0].d, 'oidc: JWKS has a public RSA key only');
        const verifier = crypto.randomBytes(32).toString('base64url'); const chal = crypto.createHash('sha256').update(verifier).digest('base64url');
        const q = (extra = {}) => '/oidc/authorize?' + new URLSearchParams({ client_id: 'ssotest', redirect_uri: 'http://localhost/cb', response_type: 'code', scope: 'openid profile', state: 'st1', nonce: 'n1', code_challenge: chal, code_challenge_method: 'S256', ...extra });
        const noSess = await O(q());
        ok(noSess.status === 200 && /<form/.test(noSess.text) && /\/oidc\/login/.test(noSess.text), 'oidc: no panel session -> sign-in form');
        ok((await O(q({ redirect_uri: 'http://evil.example/cb' }), {})).status === 400, 'oidc: unregistered redirect_uri rejected');
        const a = await O(q(), { jar: ssoJar(owner.jar) });
        const loc = new URL(a.headers.location || 'http://x/'); const code = loc.searchParams.get('code');
        ok(a.status === 302 && loc.origin === 'http://localhost' && !!code && loc.searchParams.get('state') === 'st1', 'oidc: owner gets an authorization code');
        const tk = (c, v = verifier, extra = {}) => O('/oidc/token', { method: 'POST', body: { grant_type: 'authorization_code', code: c, redirect_uri: 'http://localhost/cb', client_id: 'ssotest', client_secret: cl.secret, code_verifier: v, ...extra } });
        const bad = await tk(code, 'wrong-verifier');
        ok(bad.status === 400, 'oidc: wrong PKCE verifier rejected');
        const a2 = await O(q(), { jar: ssoJar(owner.jar) }); const code2 = new URL(a2.headers.location).searchParams.get('code');
        const t = await tk(code2); const tj = JSON.parse(t.text);
        ok(t.status === 200 && !!tj.id_token && !!tj.access_token, 'oidc: token endpoint (code + PKCE + client secret)');
        const [h, b, s] = tj.id_token.split('.');
        const pub = crypto.createPublicKey({ key: jwks.keys[0], format: 'jwk' });
        ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), pub, Buffer.from(s, 'base64url')), 'oidc: id_token RS256 signature verifies with the JWKS');
        const cl2 = JSON.parse(Buffer.from(b, 'base64url').toString());
        ok(cl2.iss === d.issuer && cl2.aud === 'ssotest' && cl2.nonce === 'n1' && cl2.preferred_username === ownerUser && cl2.exp > Date.now() / 1000 && cl2.groups.includes('admin'), 'oidc: id_token claims (iss, aud, nonce, username, admin group for owner)');
        ok((await tk(code2)).status === 400, 'oidc: authorization code is single-use');
        ok((await tk(code, verifier, { client_secret: 'nope' })).status === 401, 'oidc: wrong client secret rejected');
        const ui = await O('/oidc/userinfo', { headers: { Authorization: 'Bearer ' + tj.access_token } });
        ok(ui.status === 200 && JSON.parse(ui.text).preferred_username === ownerUser, 'oidc: userinfo with access token');
        ok((await O('/oidc/userinfo')).status === 401, 'oidc: userinfo without token -> 401');
        const ua = await O(q(), { jar: ssoJar(T.a.s.jar) }); const ca = new URL(ua.headers.location).searchParams.get('code');
        const uat = JSON.parse((await tk(ca)).text); const uac = JSON.parse(Buffer.from(uat.id_token.split('.')[1], 'base64url').toString());
        ok(uac.preferred_username === 'ssotest_a' && !uac.groups.includes('admin'), 'oidc: permitted non-owner gets a non-admin identity');
        const ub = await O(q(), { jar: ssoJar(T.b.s.jar) });
        ok(ub.status === 302 && new URL(ub.headers.location).searchParams.get('error') === 'access_denied', 'oidc: user without svc.jellyfin is denied');
      } finally {
        await api(owner.jar, 'DELETE', '/sso/oidc/clients/ssotest', undefined, owner.csrf);
        SET.set('sso.oidc', was === true, null);
      }
    }
    // ---- logout invalidates SSO ----
    const old = ssoJar(T.c.s.jar).get('sm_sso');
    const lo = await api(T.c.s.jar, 'POST', '/auth/logout', {}, T.c.s.csrf);
    ok(lo.status === 200, 'logout');
    const afterLogout = await req(CADDY, { path: '/?smsso=1', host: hostOf('radarr'), headers: NAV, jar: new Map([['sm_sso', old]]) });
    ok(!names(afterLogout.setCookie).some((n) => /RadarrAuth/.test(n)), 'after panel logout the old sm_sso gives no app session');
  } finally {
    for (const t of Object.values(T)) { try { await api(owner.jar, 'DELETE', `/panel-accounts/${t.name}`, undefined, owner.csrf); } catch {} try { await api(owner.jar, 'DELETE', `/users/${t.uid}`, undefined, owner.csrf); } catch {} }
    await api(owner.jar, 'POST', '/auth/logout', {}, owner.csrf);
  }
  console.log(`\nSSO e2e: ${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); process.exit(2); });
