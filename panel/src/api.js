// Thin client for the seemore API (/api/v1). Cookies carry the session; mutating calls send the CSRF token.
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };
export class ApiError extends Error {
  constructor(status, body) { super((body && body.error) || `HTTP ${status}`); this.status = status; this.body = body || {}; }
}
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body, { raw = false } = {}) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (method !== 'GET') opt.headers['X-CSRF-Token'] = csrf;
  let res;
  try { res = await fetch('/api/v1' + path, opt); } catch (e) { throw new ApiError(0, { error: 'ارتباط با سرور برقرار نشد' }); }
  if (raw) return res;
  let data = null; const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (res.status === 401 && path !== '/auth/login') onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);
export const q = (o) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') s.set(k, v); const t = s.toString(); return t ? `?${t}` : ''; };
