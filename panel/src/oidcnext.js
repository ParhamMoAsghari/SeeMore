// Return to an OIDC authorize request after the normal panel login (the provider redirects to /login?next=<authorize url>).
import { get } from './api.js';
export const validNext = (n) => typeof n === 'string' && n.startsWith('/oidc/authorize?') && n.length < 2000 && !/[\\\r\n]/.test(n);   // same-origin relative path only
export function nextParam() { try { const n = new URLSearchParams(location.search).get('next'); return validNext(n) ? n : null; } catch { return null; } }
export async function goNext() {
  const n = nextParam(); if (!n) return false;
  const k = 'sm-oidc-next'; let last = {}; try { last = JSON.parse(sessionStorage.getItem(k) || '{}'); } catch {}
  if (last.n === n && Date.now() - last.t < 15000) return false;   // loop guard
  sessionStorage.setItem(k, JSON.stringify({ n, t: Date.now() }));
  try { await get('/sso/services'); } catch {}   // makes sure the SSO cookie exists for sessions that began before SSO was on
  location.assign(n); return true;
}
