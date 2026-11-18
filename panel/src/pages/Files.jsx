import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { get, q } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Btn, Card, Empty, Err, Modal, Progress, Spinner, Tabs } from '../ui.jsx';
import { bytes, dateTime, pct } from '../fmt.js';
import MetaView from '../components/MetaView.jsx';

const join = (a, b) => (a ? `${a}/${b}` : b);
export default function Files() {
  const loc = useLocation(); const nav = useNavigate(); const { toast } = useApp();
  const sp = new URLSearchParams(loc.search);
  const root = sp.get('root') || 'media'; const path = sp.get('path') || '';
  const go = (r, p) => nav(`/files${q({ root: r, path: p })}`);
  const [roots] = useLoad(() => get('/files/roots'), []);
  const [ents, reload, st] = useLoad(() => get(`/files/${root}/entries${q({ path })}`), [root, path]);
  const [meta, setMeta] = useState(null);
  const showMeta = async (name) => { setMeta({ loading: true, name }); try { setMeta(await get(`/files/${root}/metadata${q({ path: join(path, name) })}`)); } catch (e) { setMeta(null); toast(e.message, 'error'); } };
  const list = (roots || []).filter((r) => r.key); const df = (roots || []).find((r) => r.df);
  return (
    <div className="stack">
      <div className="page-h"><h2>فایل‌های سرور</h2><Btn kind="ghost sm" icon="refresh" onClick={() => reload()} /></div>
      {df && <Card><div className="col"><Progress value={pct(df.df.total - df.df.free, df.df.total)} /><span className="muted small">دیسک داده: {bytes(df.df.free)} آزاد از {bytes(df.df.total)}</span></div></Card>}
      {list.length > 0 && <Tabs value={root} onChange={(r) => go(r, '')} tabs={list.map((r) => [r.key, r.label])} />}
      <div className="crumbs"><button onClick={() => go(root, '')}>ریشه</button>{path.split('/').filter(Boolean).map((p, i, a) => <React.Fragment key={i}>/<button onClick={() => go(root, a.slice(0, i + 1).join('/'))}>{p}</button></React.Fragment>)}</div>
      <Err error={st.error} retry={reload} />
      <Card pad={false}><div className="card-b">
        {path && <div className="li click" onClick={() => go(root, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}>⬆️ <span className="muted">بالا</span></div>}
        {!ents ? <Spinner /> : !ents.length ? <Empty>این پوشه خالی است.</Empty> : <div className="list">{ents.map((e) => (
          <div className="li click" key={e.name} onClick={() => (e.dir ? go(root, join(path, e.name)) : showMeta(e.name))}>
            <span className="grow ellipsis">{e.dir ? '📁' : '📄'} {e.name}</span>
            <span className="muted small" style={{ minWidth: 70 }}>{e.dir ? '' : bytes(e.size)}</span>
            <span className="muted small hide-sm">{dateTime(e.mtime)}</span>
            <button className="icon-btn" title="مشخصات" onClick={(ev) => { ev.stopPropagation(); showMeta(e.name); }}>ℹ️</button>
          </div>))}</div>}
      </div></Card>
      <p className="muted small">این بخش فقط‌خواندنی است. برای حذف فیلم/سریال از «کتابخانه» و برای انتقال از «حافظه‌ها» استفاده کنید.</p>
      {meta && <Modal wide title={`مشخصات: ${meta.name}`} onClose={() => setMeta(null)}>{meta.loading ? <Spinner /> : <MetaView m={meta} />}</Modal>}
    </div>
  );
}
