// Multi-select of library files (movies, whole series, seasons, single episodes) -> selection object
// understood by the API: { movies: [folder], series: [{ name, eps: [absolute paths] }] }.
import React, { useEffect, useMemo, useState } from 'react';
import { get } from '../api.js';
import { Badge, Empty, Err, Spinner, Tabs } from '../ui.jsx';
import { bytes, n, sxe } from '../fmt.js';

export function selSummary(lib, sel) {
  if (!lib) return { files: 0, size: 0 };
  let files = 0, size = 0;
  for (const m of sel.movies) { const x = lib.m.find((y) => y.name === m); if (x) { files += x.files.length; size += x.size; } }
  for (const [name, eps] of Object.entries(sel.eps)) { const x = lib.s.find((y) => y.name === name); if (!x) continue; for (const e of x.eps) if (eps.has(e.src)) { files++; size += e.size; } }
  return { files, size };
}
export const toApiSel = (sel) => ({ movies: sel.movies, series: Object.entries(sel.eps).filter(([, v]) => v.size).map(([name, v]) => ({ name, eps: [...v] })) });

export default function MediaPicker({ initial, onChange }) {
  const [lib, setLib] = useState(null); const [err, setErr] = useState(null);
  const [tab, setTab] = useState(initial && initial.s ? 's' : 'm'); const [f, setF] = useState(initial ? (initial.m || initial.s || '') : '');
  const [sel, setSel] = useState({ movies: [], eps: {} }); const [open, setOpen] = useState({});
  useEffect(() => { get('/library/files').then((l) => {
    setLib(l);
    if (initial && initial.m && l.m.some((x) => x.name === initial.m)) setSel({ movies: [initial.m], eps: {} });
    if (initial && initial.s) { const x = l.s.find((y) => y.name === initial.s); if (x) { const ss = initial.ss != null && initial.ss !== '' ? Number(initial.ss) : null; setSel({ movies: [], eps: { [x.name]: new Set(x.eps.filter((e) => ss == null || e.s === ss).map((e) => e.src)) } }); setOpen({ [x.name]: true }); } }
  }).catch(setErr); }, []); // eslint-disable-line
  useEffect(() => { onChange && onChange(toApiSel(sel), selSummary(lib, sel)); }, [sel, lib]); // eslint-disable-line
  const ms = useMemo(() => (lib ? lib.m.filter((x) => !f || x.name.toLowerCase().includes(f.toLowerCase())) : []), [lib, f]);
  const ss = useMemo(() => (lib ? lib.s.filter((x) => !f || x.name.toLowerCase().includes(f.toLowerCase())) : []), [lib, f]);
  if (err) return <Err error={err} />;
  if (!lib) return <Spinner />;
  const togMovie = (name, on) => setSel((s) => ({ ...s, movies: on ? [...s.movies, name] : s.movies.filter((x) => x !== name) }));
  const setEps = (name, fn) => setSel((s) => { const cur = new Set(s.eps[name] || []); fn(cur); return { ...s, eps: { ...s.eps, [name]: cur } }; });
  const sum = selSummary(lib, sel);
  return (
    <div className="col">
      <div className="row gap wrap"><Tabs value={tab} onChange={setTab} tabs={[['m', `فیلم‌ها (${n(lib.m.length)})`], ['s', `سریال‌ها (${n(lib.s.length)})`]]} /><input type="search" placeholder="فیلتر…" value={f} onChange={(e) => setF(e.target.value)} style={{ flex: 1, minWidth: 160 }} /></div>
      <div className="muted small">انتخاب‌شده: {n(sum.files)} فایل ویدیو · {bytes(sum.size)} (زیرنویس‌های کنار فایل‌ها خودکار همراه می‌شوند)</div>
      <div style={{ maxHeight: '48vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 12, padding: '4px 10px' }}>
        {tab === 'm' && (!ms.length ? <Empty /> : ms.map((m) => (
          <label className="li click" key={m.name}><input type="checkbox" className="check" checked={sel.movies.includes(m.name)} onChange={(e) => togMovie(m.name, e.target.checked)} /><span className="grow ellipsis">🎬 {m.name}</span><span className="muted small">{bytes(m.size)}</span>{m.files.some((x) => x.subs.length) && <Badge kind="ok">💬</Badge>}</label>)))}
        {tab === 's' && (!ss.length ? <Empty /> : ss.map((s) => {
          const cur = sel.eps[s.name] || new Set();
          const all = s.eps.length > 0 && s.eps.every((e) => cur.has(e.src));
          return (
            <div key={s.name} className="season" style={{ margin: '6px 0' }}>
              <header onClick={() => setOpen({ ...open, [s.name]: !open[s.name] })}>
                <input type="checkbox" checked={all} ref={(el) => el && (el.indeterminate = !all && cur.size > 0)} onClick={(e) => e.stopPropagation()} onChange={(e) => setEps(s.name, (c) => { for (const ep of s.eps) e.target.checked ? c.add(ep.src) : c.delete(ep.src); })} />
                <b className="grow ellipsis">📺 {s.name}</b><span className="muted small">{n(cur.size)}/{n(s.eps.length)} · {bytes(s.size)}</span>
              </header>
              {open[s.name] && s.seasons.map((sn) => {
                const eps = s.eps.filter((e) => e.s === sn); const allS = eps.every((e) => cur.has(e.src));
                return (
                  <div key={sn}>
                    <label className="ep" style={{ background: 'var(--bg2)' }}><input type="checkbox" checked={allS} onChange={(e) => setEps(s.name, (c) => { for (const ep of eps) e.target.checked ? c.add(ep.src) : c.delete(ep.src); })} /><b>فصل {n(sn)}</b><span className="muted small">({n(eps.length)} قسمت)</span></label>
                    {eps.map((e) => <label className="ep" key={e.src} style={{ paddingInlineStart: 34 }}><input type="checkbox" checked={cur.has(e.src)} onChange={(ev) => setEps(s.name, (c) => (ev.target.checked ? c.add(e.src) : c.delete(e.src)))} /><span className="mono">{e.e ? sxe(e.s, e.e) : ''}</span><span className="grow ellipsis ltr small">{e.name}</span><span className="muted small">{bytes(e.size)}</span>{e.subs.length > 0 && <Badge kind="ok">💬</Badge>}</label>)}
                  </div>);
              })}
            </div>);
        }))}
      </div>
    </div>
  );
}
