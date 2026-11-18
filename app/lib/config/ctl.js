'use strict';
// Container control for "reload" and "recreate" class settings — without the raw Docker socket.
//  * reload  -> restricted Docker socket proxy (DOCKER_PROXY, linuxserver/socket-proxy with only
//               CONTAINERS=1 (read) + ALLOW_RESTARTS=1). Used for container list/health/logs and restart.
//  * recreate / caddy-reload -> host helper (host/seemore-ctl, systemd path unit). seemore drops a JSON
//               request into CTL_DIR/requests; the helper (root on the host) only runs actions from its own
//               allowlist (/etc/seemore/ctl.conf) and writes CTL_DIR/results/<id>.json.
// Every request is recorded in table ctl_requests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const DB = require('../db');
const SET = require('../settings');
const U = require('../util');

const PROXY = process.env.DOCKER_PROXY || 'http://seemore-docker-proxy:2375';
const CTL_DIR = process.env.CTL_DIR || '/seemorectl';
const SELF = process.env.SELF_CONTAINER || 'seemore';

function docker(method, p, { timeout = 15000, raw = false } = {}) {
  const u = new URL(p, PROXY);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port || 2375, path: u.pathname + u.search, method, timeout }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`docker proxy ${res.statusCode}: ${buf.toString().slice(0, 160)}`), { status: res.statusCode === 403 ? 403 : 502 }));
        if (raw) return resolve(buf);
        try { resolve(buf.length ? JSON.parse(buf.toString()) : null); } catch { resolve(buf.toString()); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker proxy timeout')));
    req.on('error', (e) => reject(Object.assign(new Error('docker proxy: ' + e.message), { status: 502 })));
    req.end();
  });
}
const allowed = () => SET.list('ctl.restartable');
function check(name) { if (!allowed().includes(name)) throw Object.assign(new Error(`container ${name} is not in ctl.restartable`), { status: 403 }); return name; }

async function containers() {
  const list = await docker('GET', '/containers/json?all=1');
  const want = new Set(allowed());
  return list.filter((c) => (c.Names || []).some((n) => want.has(n.replace(/^\//, '')))).map((c) => ({
    name: c.Names[0].replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status,
    health: /\((healthy|unhealthy|health: starting)\)/.exec(c.Status || '') ? /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)[1] : null,
    created: c.Created * 1000, restartPolicy: null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}
async function inspect(name) {
  const j = await docker('GET', `/containers/${encodeURIComponent(check(name))}/json`);
  return { name, state: j.State && j.State.Status, health: j.State && j.State.Health ? j.State.Health.Status : null, startedAt: j.State && j.State.StartedAt, restartCount: j.RestartCount, restartPolicy: j.HostConfig && j.HostConfig.RestartPolicy && j.HostConfig.RestartPolicy.Name };
}
// docker log stream (non-TTY) = 8-byte frames; secrets are redacted before leaving the API
function redact(s) {
  return U.redact(String(s))
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '***')
    .replace(/\b[a-f0-9]{32,}\b/gi, '***')
    .replace(/(api[_-]?key|apikey|token|password|passwd|secret|cookie|authorization|sid)(["'\s]*[:=]\s*["']?)([^\s"',&;]+)/gi, '$1$2***');
}
async function logs(name, tail = 200) {
  const buf = await docker('GET', `/containers/${encodeURIComponent(check(name))}/logs?stdout=1&stderr=1&timestamps=1&tail=${Math.min(Number(tail) || 200, 2000)}`, { raw: true, timeout: 20000 });
  let out = ''; let i = 0;
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    while (i + 8 <= buf.length) { const n = buf.readUInt32BE(i + 4); out += buf.slice(i + 8, i + 8 + n).toString('utf8'); i += 8 + n; }
  } else out = buf.toString('utf8');
  return redact(out).split('\n').filter(Boolean).slice(-Math.min(Number(tail) || 200, 2000));
}
function record(id, action, target, status, result) {
  DB.run('INSERT INTO ctl_requests(id,t,action,target,status,result,done) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, result=excluded.result, done=excluded.done',
    id, Date.now(), action, target || null, status, result ? JSON.stringify(result).slice(0, 4000) : null, status === 'pending' ? null : Date.now());
}
// restart through the socket proxy. Restarting our own container is deferred so the HTTP answer gets out first.
async function restart(name, { by } = {}) {
  check(name);
  const id = crypto.randomBytes(6).toString('hex');
  record(id, 'restart', name, 'pending');
  if (name === SELF) {
    setTimeout(() => { docker('POST', `/containers/${encodeURIComponent(name)}/restart?t=20`, { timeout: 60000 }).catch((e) => U.log('warn', 'self restart: ' + e.message)); }, 1500);
    record(id, 'restart', name, 'scheduled', { self: true, by });
    return { id, status: 'scheduled', self: true };
  }
  try { await docker('POST', `/containers/${encodeURIComponent(name)}/restart?t=20`, { timeout: 90000 }); record(id, 'restart', name, 'ok', { by }); return { id, status: 'ok' }; }
  catch (e) { record(id, 'restart', name, 'failed', { error: e.message }); throw e; }
}
// host helper request; waits up to waitMs for the result (the helper runs within a second or two)
async function hostRequest(action, target, args = {}, waitMs = 60000) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const reqDir = path.join(CTL_DIR, 'requests'); const resDir = path.join(CTL_DIR, 'results');
  if (!fs.existsSync(reqDir)) throw Object.assign(new Error('host helper not installed (CTL_DIR missing)'), { status: 503 });
  const body = JSON.stringify({ id, action, target, args, t: Date.now() });
  const tmp = path.join(reqDir, `.${id}.tmp`); fs.writeFileSync(tmp, body, { mode: 0o640 }); fs.renameSync(tmp, path.join(reqDir, `${id}.json`));
  record(id, action, target, 'pending');
  if (!waitMs) return { id, status: 'pending' };
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await U.sleep(700);
    const f = path.join(resDir, `${id}.json`);
    if (fs.existsSync(f)) {
      let r; try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      try { fs.unlinkSync(f); } catch {}
      record(id, action, target, r.ok ? 'ok' : 'failed', r);
      if (!r.ok) throw Object.assign(new Error(`host helper: ${r.error || 'failed'}`), { status: 502, result: r });
      return { id, status: 'ok', result: r };
    }
  }
  record(id, action, target, 'timeout');
  throw Object.assign(new Error('host helper did not answer in time'), { status: 504 });
}
const requests = (limit = 30) => DB.all('SELECT * FROM ctl_requests ORDER BY t DESC LIMIT ?', limit).map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
async function ping() { try { await docker('GET', '/_ping', { timeout: 4000 }); return true; } catch { return false; } }
const helperInstalled = () => fs.existsSync(path.join(CTL_DIR, 'requests'));
module.exports = { docker, containers, inspect, logs, restart, hostRequest, requests, ping, helperInstalled, redact, SELF };
