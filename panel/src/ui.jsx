// Small UI kit (no external UI library). RTL-first.
import React, { useEffect, useState } from 'react';
import { n } from './fmt.js';

export const Icon = ({ name, size = 18 }) => {
  const P = {
    home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z', search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 17l-4.3-4.3',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4', download: 'M12 3v12m0 0l-5-5m5 5l5-5M4 19h16',
    cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', drive: 'M3 15h18v4H3zM5 15l2-9h10l2 9M17 17h.01', folder: 'M3 6h6l2 2h10v11H3z',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8m5 10a7 7 0 0 0-4-6.3',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.5a7.6 7.6 0 0 0-2 1.2l-2.5-1-2 3.5 2.1 1.6a7.4 7.4 0 0 0 0 2.4l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2-1.2l2.5 1 2-3.5-2.1-1.6c.1-.4.1-.8.1-1.2z',
    pulse: 'M3 12h4l3-8 4 16 3-8h4', jobs: 'M4 6h16M4 12h16M4 18h10', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3', menu: 'M3 6h18M3 12h18M3 18h18', x: 'M6 6l12 12M18 6L6 18', check: 'M5 12l5 5 9-10',
    play: 'M7 4l13 8-13 8z', pause: 'M7 4h4v16H7zM13 4h4v16h-4z', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    up: 'M12 19V5m0 0l-6 6m6-6l6 6', refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', copy: 'M8 8h12v12H8zM4 16V4h12', file: 'M6 3h8l4 4v14H6zM14 3v4h4', eject: 'M12 4l8 10H4zM4 18h16v2H4z', plus: 'M12 5v14M5 12h14', back: 'M9 6l6 6-6 6',
  };
  return <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[name] || P.info} /></svg>;
};
export const Btn = ({ kind = '', icon, children, busy, className = '', ...p }) => (
  <button className={`btn ${kind} ${className}`} disabled={busy || p.disabled} {...p}>{busy ? <span className="spin sm" /> : icon ? <Icon name={icon} /> : null}{children ? <span>{children}</span> : null}</button>
);
export const Card = ({ title, actions, children, className = '', pad = true }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <header className="card-h"><h3>{title}</h3><div className="row gap">{actions}</div></header>}
    <div className={pad ? 'card-b' : ''}>{children}</div>
  </section>
);
export const Spinner = ({ label }) => <div className="center muted pad"><span className="spin" /> {label || 'در حال بارگذاری…'}</div>;
export const Empty = ({ children = 'چیزی برای نمایش نیست.' }) => <div className="empty">{children}</div>;
export const Err = ({ error, retry }) => error ? <div className="alert err"><span>{error.message || String(error)}</span>{retry && <Btn kind="ghost sm" icon="refresh" onClick={() => retry()}>دوباره</Btn>}</div> : null;
export const Badge = ({ kind = '', children, title }) => <span className={`badge ${kind}`} title={title}>{children}</span>;
export const Progress = ({ value = 0, kind = '' }) => <div className={`prog ${kind}`}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-h"><h3>{title}</h3>{onClose && <button className="icon-btn" onClick={onClose} aria-label="بستن"><Icon name="x" /></button>}</header>
        <div className="modal-b">{children}</div>
        {footer && <footer className="modal-f">{footer}</footer>}
      </div>
    </div>
  );
}
// promise-based confirm: const ok = await confirmDialog(...) is awkward in React; use <Confirm> state instead
export function Confirm({ title = 'تأیید', text, danger, okText = 'تأیید', onOk, onClose, children }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Btn kind="ghost" onClick={onClose}>انصراف</Btn>
      <Btn kind={danger ? 'danger' : 'primary'} busy={busy} onClick={async () => { setBusy(true); try { await onOk(); onClose(); } catch { setBusy(false); } }}>{okText}</Btn>
    </>}>
      {text && <p>{text}</p>}{children}
    </Modal>
  );
}
export const Field = ({ label, hint, children, className = '' }) => <label className={`field ${className}`}><span className="lbl">{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
export const Toggle = ({ checked, onChange, disabled, label }) => (
  <label className={`toggle ${disabled ? 'dis' : ''}`}><input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><i />{label && <span>{label}</span>}</label>
);
export const Tabs = ({ tabs, value, onChange }) => (
  <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>
);
export function Poster({ refId, title, className = '' }) {
  const [bad, setBad] = useState(!refId);
  useEffect(() => setBad(!refId), [refId]);
  if (bad) return <div className={`poster ph ${className}`}><span>{(title || '?').slice(0, 2)}</span></div>;
  return <img className={`poster ${className}`} src={`/api/v1/media/posters/${encodeURIComponent(refId)}`} alt="" loading="lazy" onError={() => setBad(true)} />;
}
export const KV = ({ rows }) => <dl className="kv">{rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>;
export const Stat = ({ label, value, sub, icon }) => <div className="stat">{icon && <Icon name={icon} size={22} />}<div><div className="stat-v">{value}</div><div className="stat-l">{label}</div>{sub && <div className="muted small">{sub}</div>}</div></div>;
export const num = n;
export function useDebounced(v, ms = 400) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }
