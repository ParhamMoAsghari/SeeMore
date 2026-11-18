import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, q } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, KV, Modal, Progress, Spinner, Stat, Tabs } from '../ui.jsx';
import { ago, bytes, dateTime, dur, n, pct } from '../fmt.js';

const NS = { pending: ['در صف', 'pri'], sent: ['ارسال شد', 'ok'], failed: ['ناموفق', 'err'], dead: ['رها شد', 'err'] };

function Logs({ name, onClose }) {
  const [tail, setTail] = useState(300); const [f, setF] = useState('');
  const [txt, reload, st] = useLoad(() => get(`/system/containers/${name}/logs${q({ tail })}`), [name, tail], { interval: 5000 });
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [txt]);
  const lines = (Array.isArray(txt) ? txt : String(txt || '').split('\n')).filter((l) => !f || l.toLowerCase().includes(f.toLowerCase()));
  return (
    <Modal wide title={`لاگ ${name}`} onClose={onClose}>
      <div className="row gap"><input placeholder="فیلتر…" value={f} onChange={(e) => setF(e.target.value)} /><select value={tail} onChange={(e) => setTail(Number(e.target.value))} style={{ width: 'auto' }}>{[100, 300, 1000, 3000].map((x) => <option key={x} value={x}>{n(x)} خط</option>)}</select><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <Err error={st.error} />
      <pre ref={box} className="logbox ltr" style={{ maxHeight: '60vh' }}>{lines.join('\n')}</pre>
      <p className="muted small">توکن‌ها و رمزها پیش از نمایش حذف می‌شوند. هر ۵ ثانیه تازه می‌شود.</p>
    </Modal>
  );
}

export default function Health() {
  const { me, toast } = useApp();
  const [tab, setTab] = useState('services');
  const [h, reload, st] = useLoad(() => get('/health'), [], { interval: 15000 });
  const [srv] = useLoad(() => get('/system/status'), [], { interval: 30000 });
  const [logs, setLogs] = useState(null); const [rs, setRs] = useState(null);
  const tabs = [['services', 'سرویس‌ها'], ['recovery', 'بازیابی کارها'], ...(me.owner ? [['containers', 'کانتینرها'], ['notify', 'اعلان‌ها'], ['ctl', 'کنترل میزبان']] : [])];
  return (
    <div className="stack">
      <div className="page-h"><h2>سلامت و لاگ‌ها</h2><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <Err error={st.error} retry={reload} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {!h ? <Spinner /> : <>
        {tab === 'services' && <div className="stack">
          {srv && <div className="grid g4">
            <Stat icon="pulse" label="بار پردازنده" value={srv.load.map((x) => n(x)).join(' / ')} sub={`${n(srv.cores)} هسته`} />
            <Stat icon="info" label="حافظه‌ی آزاد" value={bytes(srv.mem.avail)} sub={`از ${bytes(srv.mem.total)}`} />
            <Stat icon="drive" label="دیسک داده" value={srv.disk ? bytes(srv.disk.freeSpace) : '—'} sub={srv.disk ? `آزاد از ${bytes(srv.disk.totalSpace)}` : ''} />
            <Stat icon="refresh" label="روشن از" value={dur(srv.up)} sub={h.process ? `seemore ${dur(h.process.uptimeSec)} · ${n(h.process.rssMB)}MB` : ''} />
          </div>}
          <Card title="سرویس‌ها">{!h.services ? <Empty>اطلاعات سرویس‌ها در دسترس نیست.</Empty> : <div className="grid g3">{h.services.map((s) => (
            <div key={s.name} className="li"><span className={`dot ${s.ok ? 'ok' : 'err'}`} /><b className="grow">{s.name}</b><span className="muted small">{s.ok ? `${n(s.ms)}ms` : s.error || 'قطع'}</span></div>))}</div>}</Card>
          {srv && srv.warnings.length > 0 && <Card title="هشدارهای Radarr / Sonarr / Prowlarr">{srv.warnings.map((w, i) => <div key={i} className="li small"><Badge kind={w.type === 'error' ? 'err' : 'warn'}>{w.src}</Badge><span className="ltr grow" style={{ textAlign: 'left' }}>{w.m}</span></div>)}</Card>}
          {srv && <Card title="ایندکسرها"><div className="chip-row">{srv.idx.map((i) => <Badge key={i.name} kind={!i.enable ? '' : i.st && i.st.disabledTill ? 'warn' : 'ok'}>{i.name}{!i.enable ? ' (خاموش)' : ''}</Badge>)}</div></Card>}
          {h.drives && <Card title="حافظه‌های خارجی">{!h.drives.length ? <span className="muted small">هیچ حافظه‌ای وصل نیست.</span> : h.drives.map((d) => <div key={d.name} className="li small"><b className="grow">{d.name}</b><Badge>{d.fstype}</Badge>{d.ro && <Badge kind="warn">فقط‌خواندنی</Badge>}{d.marker && <Badge kind="ok">نشانه‌ی seemore</Badge>}{d.fsck && <span className="muted">{d.fsck}</span>}</div>)}</Card>}
        </div>}
        {tab === 'recovery' && h.recovery && <div className="stack">
          <p className="muted small">این بخش وضعیت سلامت سرویس‌ها نیست؛ نشان می‌دهد کارهای انتقال بعد از قطع برق، کشیدن حافظه یا ری‌استارت چطور بازیابی شده‌اند.</p>
          <div className="grid g4">{Object.entries(h.recovery.counts).map(([k, v]) => <Stat key={k} label={k} value={n(v)} />)}<Stat label="ناموفق در ۲۴ ساعت" value={n(h.recovery.failed24h)} /></div>
          <Card title="منتظر حافظه">{!h.recovery.waiting.length ? <span className="muted small">هیچ کاری منتظر نیست.</span> : h.recovery.waiting.map((j) => <div key={j.id} className="li small"><Link to="/jobs" className="grow">{j.title}</Link>{j.devices.map((d) => <Badge key={d.name} kind={d.present ? 'ok' : 'warn'}>{d.name}</Badge>)}</div>)}</Card>
          <Card title="بازیابی‌های اخیر (۲۴ ساعت)">{!h.recovery.recentlyRecovered.length ? <span className="muted small">موردی نیست.</span> : h.recovery.recentlyRecovered.map((j) => <div key={j.id} className="li small"><span className="grow">{j.title}</span><span className="muted ltr">{typeof j.recovery === 'object' ? JSON.stringify(j.recovery) : j.recovery}</span></div>)}</Card>
          {h.outbox && <Card title="صف اعلان‌ها"><div className="row gap wrap">{Object.entries(h.outbox).map(([k, v]) => <Badge key={k} kind={NS[k]?.[1]}>{NS[k]?.[0] || k}: {n(v)}</Badge>)}</div></Card>}
        </div>}
        {tab === 'containers' && <Card pad={false}><div className="card-b list">{Array.isArray(h.containers) ? h.containers.map((c) => (
          <div key={c.name} className="li wrap">
            <span className={`dot ${c.state === 'running' && c.health !== 'unhealthy' ? 'ok' : 'err'}`} />
            <div className="grow col" style={{ gap: 2 }}><b className="ltr" style={{ textAlign: 'right' }}>{c.name}</b><span className="muted small ltr" style={{ textAlign: 'right' }}>{c.status} · {c.image}</span></div>
            <Btn kind="sm ghost" onClick={() => setLogs(c.name)}>لاگ</Btn>
            <Btn kind="sm ghost" icon="refresh" onClick={() => setRs(c.name)}>ری‌استارت</Btn>
          </div>)) : <div className="alert err">{h.containers && h.containers.error ? `پراکسی داکر در دسترس نیست: ${h.containers.error}` : 'اطلاعاتی نیست'}</div>}</div></Card>}
        {tab === 'notify' && <Notifications />}
        {tab === 'ctl' && <Ctl />}
      </>}
      {logs && <Logs name={logs} onClose={() => setLogs(null)} />}
      {rs && <Confirm danger title={`ری‌استارت ${rs}`} okText="ری‌استارت" text={(rs === 'seemore' || rs === 'media-bot') ? 'ربات و پنل چند ثانیه قطع می‌شوند؛ کارهای در حال انجام بعد از بالا آمدن خودکار ادامه پیدا می‌کنند.' : 'سرویس چند ثانیه در دسترس نیست.'} onClose={() => setRs(null)} onOk={async () => { try { await post(`/system/containers/${rs}/restart`); toast('ری‌استارت انجام شد', 'ok'); setTimeout(() => reload(true), 4000); } catch (e) { toast(e.message, 'error'); throw e; } }} />}
    </div>
  );
}
function Notifications() {
  const [list, reload, st] = useLoad(() => get('/system/notifications?limit=100'), []);
  return <Card title="آخرین اعلان‌های ربات" actions={<Btn kind="sm ghost" icon="refresh" onClick={() => reload()} />}><Err error={st.error} />{!list ? <Spinner /> : !list.length ? <Empty /> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>زمان</th><th>نوع</th><th>گیرنده</th><th>وضعیت</th><th>تلاش</th><th>خطا</th></tr></thead><tbody>{list.map((x) => <tr key={x.id}><td className="nowrap">{dateTime(x.t)}</td><td>{x.kind}</td><td className="ltr">{x.uid}</td><td><Badge kind={NS[x.status]?.[1]}>{NS[x.status]?.[0] || x.status}</Badge></td><td>{n(x.attempts)}</td><td className="small ltr">{x.err}</td></tr>)}</tbody></table></div>}</Card>;
}
function Ctl() {
  const [c, reload, st] = useLoad(() => get('/system/ctl'), []);
  return <Card title="درخواست‌ها به کمک‌کار میزبان (seemore-ctl)" actions={<Btn kind="sm ghost" icon="refresh" onClick={() => reload()} />}><Err error={st.error} />{!c ? <Spinner /> : <>
    <p className="small">{c.helper ? <Badge kind="ok">نصب است</Badge> : <Badge kind="err">نصب نیست — تغییرات «ساخت دوباره» و «Caddy» کار نمی‌کنند</Badge>}</p>
    {!c.requests.length ? <Empty>درخواستی ثبت نشده.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>زمان</th><th>عمل</th><th>هدف</th><th>وضعیت</th><th>نتیجه</th></tr></thead><tbody>{c.requests.map((r) => <tr key={r.id}><td className="nowrap">{dateTime(r.t)}</td><td>{r.action}</td><td>{r.target}</td><td><Badge kind={r.status === 'ok' ? 'ok' : r.status === 'pending' ? 'pri' : 'err'}>{r.status}</Badge></td><td className="small ltr">{r.result ? JSON.stringify(r.result).slice(0, 200) : ''}</td></tr>)}</tbody></table></div>}
  </>}</Card>;
}
