'use strict';
// HTTP clients for Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent and Jellyfin.
// GET requests retry with backoff so the bot survives starting before the other containers.
const { retry, redact } = require('./util');
const E = process.env;

class ApiError extends Error {}

class Http {
  constructor(name, base, headers = {}, timeout = 40000) { Object.assign(this, { name, base, headers, timeout }); }
  async req(path, { method = 'GET', body, timeout, tries, headers, raw } = {}) {
    tries = tries ?? (method === 'GET' ? 4 : 1);
    return retry(async () => {
      let res;
      const h = { ...this.headers, ...headers };
      let payload;
      if (body instanceof URLSearchParams) payload = body;
      else if (body != null) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
      try {
        res = await fetch(this.base + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout || this.timeout) });
      } catch (e) {
        const err = new ApiError(`${this.name}: ${(e.cause && e.cause.code) || e.name}`);
        err.net = true; err.svc = this.name; throw err;
      }
      if (raw) return res;
      const text = await res.text();
      let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const msg = Array.isArray(data) ? data.map((x) => x.errorMessage || x.message).filter(Boolean).join('; ')
          : (data && (data.message || data.error)) || String(text).slice(0, 150);
        const err = new ApiError(redact(`${this.name} ${res.status}: ${msg}`.slice(0, 250)));
        err.status = res.status; err.svc = this.name; throw err;
      }
      return data;
    }, { tries, base: 1500, max: 8000, shouldRetry: (e) => e.net || (e.status >= 502 && e.status <= 504) });
  }
}

class Arr {
  constructor(name, url, key, v = 'v3') {
    this.name = name;
    this.http = new Http(name, `${url}/api/${v}`, { 'X-Api-Key': key });
    this.root = new Http(name, url, { 'X-Api-Key': key }, 10000);
  }
  get(p, o) { return this.http.req(p, o); }
  post(p, body, o) { return this.http.req(p, { method: 'POST', body, ...o }); }
  put(p, body, o) { return this.http.req(p, { method: 'PUT', body, ...o }); }
  del(p, body, o) { return this.http.req(p, { method: 'DELETE', body, ...o }); }
  ping() { return this.root.req('/ping', { tries: 1 }); }
}

const radarr = new Arr('Radarr', E.RADARR_URL || 'http://radarr:7878', E.RADARR_KEY);
const sonarr = new Arr('Sonarr', E.SONARR_URL || 'http://sonarr:8989', E.SONARR_KEY);
const prowlarr = new Arr('Prowlarr', E.PROWLARR_URL || 'http://prowlarr:9696', E.PROWLARR_KEY, 'v1');

class Bazarr {
  constructor() { this.http = new Http('Bazarr', (E.BAZARR_URL || 'http://bazarr:6767') + '/api', { 'X-API-KEY': E.BAZARR_KEY || '' }, 15000); }
  get(p, o) { return this.http.req(p, o); }
}
const bazarr = new Bazarr();

class QBit {
  constructor() { this.http = new Http('qBittorrent', (E.QBIT_URL || 'http://qbittorrent:8080') + '/api/v2', {}, 15000); this.cookie = null; this.v5 = null; }
  async login() {
    // never hammer the login: qBittorrent bans the client IP after a few failures
    if (this.failedAt && Date.now() - this.failedAt < 600000) { const e = new ApiError('qBittorrent: login paused after failure'); e.svc = 'qBittorrent'; throw e; }
    const res = await this.http.req('/auth/login', { method: 'POST', raw: true, tries: 1, body: new URLSearchParams({ username: E.QBIT_USER || '', password: E.QBIT_PASS || '' }) });
    const ck = (res.headers.get('set-cookie') || '').split(';')[0];
    if (!ck) { this.failedAt = Date.now(); const e = new ApiError(`qBittorrent: login failed (${res.status})`); e.svc = 'qBittorrent'; throw e; }
    this.failedAt = 0;
    this.cookie = ck;
  }
  async req(path, o = {}) {
    if (!this.cookie) await this.login();
    try { return await this.http.req(path, { ...o, headers: { Cookie: this.cookie } }); }
    catch (e) {
      if (e.status === 403) { await this.login(); return this.http.req(path, { ...o, headers: { Cookie: this.cookie } }); }
      throw e;
    }
  }
  torrents() { return this.req('/torrents/info'); }
  transfer() { return this.req('/transfer/info'); }
  async version() { return this.req('/app/version'); }
  async action(kind, hash) {
    if (this.v5 === null) { try { this.v5 = /^v?5/.test(String(await this.version())); } catch { this.v5 = true; } }
    const name = kind === 'pause' ? (this.v5 ? 'stop' : 'pause') : (this.v5 ? 'start' : 'resume');
    try { return await this.req(`/torrents/${name}`, { method: 'POST', body: new URLSearchParams({ hashes: hash }) }); }
    catch (e) {
      if (e.status === 404) { const alt = kind === 'pause' ? (this.v5 ? 'pause' : 'stop') : (this.v5 ? 'resume' : 'start'); return this.req(`/torrents/${alt}`, { method: 'POST', body: new URLSearchParams({ hashes: hash }) }); }
      throw e;
    }
  }
}
const qbit = new QBit();

class Jellyfin {
  constructor() {
    this.http = new Http('Jellyfin', E.JELLYFIN_API || 'http://jellyfin:8096', {}, 20000);
    this.token = null;
    this.auth = 'MediaBrowser Client="MediaBot", Device="bot", DeviceId="media-bot", Version="2.0"';
  }
  async login() {
    if (this.failedAt && Date.now() - this.failedAt < 600000) { const e = new ApiError('Jellyfin: login paused after failure'); e.svc = 'Jellyfin'; throw e; }
    try {
      const d = await this.http.req('/Users/AuthenticateByName', { method: 'POST', tries: 2, headers: { Authorization: this.auth }, body: { Username: E.JELLYFIN_USER, Pw: E.JELLYFIN_PASS } });
      this.token = d.AccessToken; this.failedAt = 0;
    } catch (e) { if (e.status === 401 || e.status === 403) this.failedAt = Date.now(); throw e; }
  }
  async req(path, o = {}) {
    if (!this.token) await this.login();
    const h = () => ({ Authorization: `${this.auth}, Token="${this.token}"` });
    try { return await this.http.req(path, { ...o, headers: h() }); }
    catch (e) { if (e.status === 401) { await this.login(); return this.http.req(path, { ...o, headers: h() }); } throw e; }
  }
  // Find a library item and return its id (used for deep links)
  async find(kind, item) {
    const type = kind === 'm' ? 'Movie' : 'Series';
    const q = new URLSearchParams({ Recursive: 'true', IncludeItemTypes: type, Fields: 'ProviderIds,ProductionYear', SearchTerm: item.title, Limit: '20' });
    const d = await this.req('/Items?' + q);
    const items = (d && d.Items) || [];
    const pid = (x, k) => String((x.ProviderIds || {})[k] || '').toLowerCase();
    const hit = items.find((x) => (item.tmdbId && pid(x, 'Tmdb') === String(item.tmdbId)) || (item.imdbId && pid(x, 'Imdb') === String(item.imdbId).toLowerCase()) || (item.tvdbId && pid(x, 'Tvdb') === String(item.tvdbId)))
      || items.find((x) => x.Name.toLowerCase() === String(item.title).toLowerCase() && (!item.year || !x.ProductionYear || Math.abs(x.ProductionYear - item.year) <= 1));
    return hit ? hit.Id : null;
  }
  refresh() { return this.req('/Library/Refresh', { method: 'POST', tries: 1 }); }
  ping() { return this.http.req('/System/Info/Public', { tries: 1, timeout: 8000 }); }
}
const jellyfin = new Jellyfin();

module.exports = { radarr, sonarr, prowlarr, bazarr, qbit, jellyfin, ApiError };
