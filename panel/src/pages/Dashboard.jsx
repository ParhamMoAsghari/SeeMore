import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Card, Empty, Progress, Spinner, Stat } from '../ui.jsx';
import { ago, bytes, dur, n, pct, speed } from '../fmt.js';
import JobCard from '../components/JobCard.jsx';
import { ServicesCard } from './Services.jsx';

export default function Dashboard() {
  const { me, can, live } = useApp();
  const [srv] = useLoad(() => (can('server') ? get('/system/status') : null), [], { interval: 20000 });
  const [jobs, reloadJobs] = useLoad(() => get('/jobs?active=1&limit=20'), []);
  const [dl] = useLoad(() => (can('downloads') ? get('/downloads') : null), [], { interval: 5000 });
  const [drives, reloadDrives] = useLoad(() => (can('usb_view') ? get('/storage/devices') : null), []);
  const [recent] = useLoad(() => (can('library') ? get('/library/recent') : null), []);
  useEffect(() => { reloadJobs(true); }, [live.jobTick]); // eslint-disable-line
  useEffect(() => { if (live.drives) reloadDrives(true); }, [live.drives]); // eslint-disable-line
  const okSvc = srv ? srv.services.filter(([, r]) => r.ok).length : 0;
  return (
    <div className="stack">
      <div className="page-h"><h2>سلام{me.name ? ` ${me.name}` : ''} 👋</h2><span className="muted small">{live.connected ? 'به‌روزرسانی زنده فعال است' : 'در حال اتصال…'}</span></div>
      <ServicesCard />
      {srv && <div className="grid g4">
        <Stat icon="pulse" label="سرویس‌ها" value={`${n(okSvc)} از ${n(srv.services.length)}`} sub={okSvc === srv.services.length ? 'همه سالم' : srv.services.filter(([, r]) => !r.ok).map(([s]) => s).join('، ')} />
        <Stat icon="drive" label="فضای آزاد آرشیو" value={srv.disk ? bytes(srv.disk.freeSpace) : '—'} sub={srv.disk ? `از ${bytes(srv.disk.totalSpace)}` : ''} />
        <Stat icon="gear" label="حافظه‌ی رم آزاد" value={bytes(srv.mem.avail)} sub={`بار: ${srv.load.map((x) => n(x.toFixed(2))).join(' / ')}`} />
        <Stat icon="download" label="سرعت دانلود" value={srv.tr ? speed(srv.tr.dl_info_speed) : '—'} sub={srv.tr ? `آپلود ${speed(srv.tr.up_info_speed)}` : ''} />
      </div>}
      {srv && srv.warnings.length > 0 && <div className="alert warn"><span>⚠️ {srv.warnings.slice(0, 3).map((w) => `${w.src}: ${w.m}`).join(' — ')}</span></div>}
      <div className="grid g2">
        <Card title="کارهای در جریان" actions={<Link to="/jobs" className="small">همه</Link>}>
          {!jobs ? <Spinner /> : !jobs.length ? <Empty>کاری در جریان نیست.</Empty> : <div className="list">{jobs.map((j) => <JobCard key={j.id} job={j} compact onChange={() => reloadJobs(true)} />)}</div>}
        </Card>
        {can('downloads') && <Card title="دانلودها" actions={<Link to="/downloads" className="small">مدیریت</Link>}>
          {!dl ? <Spinner /> : !dl.items.length ? <Empty>دانلودی در جریان نیست.</Empty> : <div className="list">{dl.items.slice(0, 6).map((it) => (
            <div className="li" key={it.id}><div className="grow col" style={{ gap: 4 }}>
              <div className="row gap between"><b className="ellipsis">{it.name}{it.sub ? ` · ${it.sub}` : ''}</b><span className="small muted">{n(Math.round(it.progress))}٪</span></div>
              <Progress value={it.progress} />
              <div className="muted small row gap wrap"><span>{it.state}</span>{it.speed > 0 && <span>{speed(it.speed)}</span>}{it.eta != null && <span>{dur(it.eta)}</span>}</div>
            </div></div>))}</div>}
        </Card>}
        {can('usb_view') && <Card title="حافظه‌های خارجی" actions={<Link to="/drives" className="small">مرور</Link>}>
          {!drives ? <Spinner /> : !drives.length ? <Empty>حافظه‌ای وصل نیست.</Empty> : <div className="list">{drives.map((d) => (
            <Link className="li click" key={d.id} to={`/drives/${encodeURIComponent(d.id)}`}><div className="grow col" style={{ gap: 4 }}>
              <div className="row gap between"><b>💾 {d.title || d.name}</b><span className="row gap"><Badge>{d.fstype}</Badge>{d.busy && <Badge kind="pri">در حال انتقال</Badge>}</span></div>
              <Progress value={pct(d.total - d.free, d.total)} /><span className="muted small">{bytes(d.free)} آزاد از {bytes(d.total)}</span>
            </div></Link>))}</div>}
        </Card>}
        {recent && <Card title="تازه‌ها" actions={<Link to="/library" className="small">کتابخانه</Link>}>
          {!recent.imported.length ? <Empty /> : <div className="list">{recent.imported.slice(0, 6).map((r, i) => <div className="li" key={i}><span>{r.k === 'm' ? '🎬' : '📺'}</span><span className="grow ellipsis">{r.title}</span><span className="muted small">{ago(r.date)}</span></div>)}</div>}
        </Card>}
      </div>
    </div>
  );
}
