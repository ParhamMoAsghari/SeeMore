// Global state: session, live events (SSE with Last-Event-ID replay), toasts, theme.
import { goNext } from './oidcnext.js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, setCsrf, setUnauthorizedHandler } from './api.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [me, setMe] = useState(undefined);       // undefined = loading, null = logged out
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('sm-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  const [live, setLive] = useState({ progress: {}, drives: null, connected: false, lastSeq: 0, jobTick: 0 });
  const listeners = useRef(new Set());

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('sm-theme', theme); }, [theme]);
  const toast = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text: String(text), kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const refresh = useCallback(async () => {
    try { const s = await get('/auth/session'); setCsrf(s.csrf); setMe(s); goNext(); } catch { setMe(null); }
  }, []);
  useEffect(() => { refresh(); setUnauthorizedHandler(() => setMe(null)); }, [refresh]);
  const logout = useCallback(async () => { try { await post('/auth/logout'); } catch {} setMe(null); }, []);

  // SSE: the browser resends Last-Event-ID automatically on reconnect; we also keep it across re-creations
  useEffect(() => {
    if (!me) return undefined;
    let es; let stop = false; let last = Number(sessionStorage.getItem('sm-last-seq') || 0);
    const open = () => {
      es = new EventSource(`/api/v1/events${last ? `?after=${last}` : ''}`);
      es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); setLive((l) => ({ ...l, connected: true, lastSeq: d.lastSeq })); });
      es.addEventListener('job', (e) => {
        const d = JSON.parse(e.data); last = d.seq; sessionStorage.setItem('sm-last-seq', String(last));
        setLive((l) => ({ ...l, lastSeq: d.seq, jobTick: l.jobTick + 1 }));
        for (const fn of listeners.current) fn('job', d);
      });
      es.addEventListener('progress', (e) => { const d = JSON.parse(e.data); setLive((l) => ({ ...l, progress: { ...l.progress, [d.job]: { ...d, at: Date.now() } } })); });
      es.addEventListener('drives', (e) => { const d = JSON.parse(e.data); setLive((l) => ({ ...l, drives: d.drives })); for (const fn of listeners.current) fn('drives', d); });
      es.addEventListener('settings', (e) => { for (const fn of listeners.current) fn('settings', JSON.parse(e.data)); });
      es.onerror = () => { setLive((l) => ({ ...l, connected: false })); if (es.readyState === 2 && !stop) setTimeout(open, 3000); };
    };
    open();
    return () => { stop = true; es && es.close(); };
  }, [me]);
  const subscribe = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  const can = useCallback((p) => !!me && (p === 'svc' ? (me.perms || []).some((x) => x.startsWith('svc.')) : (me.perms || []).includes(p)), [me]);   // 'svc' = any service login permission

  const value = useMemo(() => ({ me, setMe, refresh, logout, toast, theme, setTheme, live, subscribe, can }), [me, refresh, logout, toast, theme, live, subscribe, can]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </Ctx.Provider>
  );
}

// data loader hook: const [data, reload, {loading, error}] = useLoad(() => get('/x'), [deps])
export function useLoad(fn, deps = [], { interval = 0 } = {}) {
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  const fnRef = useRef(fn); fnRef.current = fn;
  const run = useCallback(async (quiet) => {
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try { const data = await fnRef.current(); setState({ data, loading: false, error: null }); }
    catch (e) { setState((s) => ({ ...s, loading: false, error: e })); }
  }, []);
  useEffect(() => { run(); if (!interval) return undefined; const t = setInterval(() => { if (!document.hidden) run(true); }, interval); return () => clearInterval(t); }, deps); // eslint-disable-line
  return [state.data, run, state];
}
