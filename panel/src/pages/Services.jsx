import React from 'react';
import { get } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Card, Empty, Spinner } from '../ui.jsx';

// One-click links to the media services this user may sign in to (the server only returns permitted ones).
export function ServiceTiles({ data }) {
  if (!data) return <Spinner />;
  if (!data.services.length) return <Empty>دسترسی به سرویسی برای شما فعال نیست. از مالک بخواهید در «کاربران و دسترسی‌ها» اضافه کند.</Empty>;
  return (
    <div className="svc-grid">
      {data.services.map((s) => (
        <a key={s.id} className="svc-tile" href={s.url} target="_blank" rel="noopener noreferrer" data-svc={s.id}>
          <span className="svc-ic" aria-hidden="true">{s.icon}</span>
          <b>{s.name}</b>
          <span className="muted small">{s.desc}</span>
          <Badge kind={s.sso === 'auto' ? 'ok' : ''}>{s.sso === 'auto' ? 'ورود خودکار' : 'ورود با رمز سرویس'}</Badge>
        </a>
      ))}
    </div>
  );
}

export function ServicesCard() {
  const { can } = useApp();
  const [data] = useLoad(() => (can('svc') ? get('/sso/services') : null), []);
  if (!can('svc')) return null;
  return <Card title="سرویس‌ها · ورود یک‌کلیکی"><ServiceTiles data={data} /></Card>;
}

export default function Services() {
  const [data] = useLoad(() => get('/sso/services'), []);
  return (
    <div className="stack">
      <div className="page-h"><h2>سرویس‌ها</h2><span className="muted small">با همین ورود پنل، بدون رمز جدا؛ ورود با نام کاربری و رمز خود سرویس‌ها هم همیشه کار می‌کند.</span></div>
      <Card><ServiceTiles data={data} /></Card>
    </div>
  );
}
