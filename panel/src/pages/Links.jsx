import React, { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { del, get, patch, post, q } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, Field, Modal, Spinner, Tabs } from '../ui.jsx';
import { ago, bytes, dateTime, n } from '../fmt.js';
import MediaPicker from '../components/MediaPicker.jsx';

const EXP = [['3600000', '۱ ساعت'], ['86400000', '۱ روز'], ['259200000', '۳ روز'], ['604800000', '۱ هفته'], ['2592000000', '۳۰ روز'], ['', 'بدون انقضا']];
const STATE = { active: ['فعال', 'ok'], expired: ['منقضی', 'warn'], revoked: ['باطل‌شده', 'err'], used: ['سقف دانلود پر شد', 'warn'] };
const KIND = { zip: 'ZIP', rar: 'RAR', file: 'فایل مستقیم' };

function copy(text, toast) { navigator.clipboard?.writeText(text).then(() => toast('کپی شد', 'ok'), () => toast(text)); }

function NewLink({ initial, onClose, onDone }) {
  const { me, toast } = useApp();
  const [sel, setSel] = useState(null); const [sum, setSum] = useState({ files: 0 });
  const [kind, setKind] = useState('zip'); const [exp, setExp] = useState('604800000'); const [maxDl, setMaxDl] = useState(''); const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const rarOn = me.features && me.features.links_rar;
  const make = async () => { setBusy(true); setErr(null); try { const l = await post('/shares', { sel, kind, title: title || undefined, expires: exp ? Date.now() + Number(exp) : null, maxDl: maxDl ? Number(maxDl) : null }); toast('لینک ساخته شد', 'ok'); onDone(l); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <Modal wide title="لینک دانلود جدید" onClose={onClose} footer={<><Btn kind="primary" busy={busy} disabled={!sum.files} onClick={make}>ساخت لینک</Btn><Btn kind="ghost" onClick={onClose}>انصراف</Btn></>}>
      <div className="col">
        <MediaPicker initial={initial} onChange={(s, m) => { setSel(s); setSum(m); }} />
        <div className="grid g3">
          <Field label="نوع"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="zip">ZIP (بدون فشرده‌سازی، فوری)</option>{rarOn && <option value="rar">RAR (ساخت در پس‌زمینه)</option>}<option value="file">فایل‌ها جداگانه</option></select></Field>
          <Field label="اعتبار"><select value={exp} onChange={(e) => setExp(e.target.value)}>{EXP.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="سقف تعداد دانلود (اختیاری)"><input type="number" min="1" value={maxDl} onChange={(e) => setMaxDl(e.target.value)} /></Field>
        </div>
        <Field label="عنوان (اختیاری)"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Err error={err} />
      </div>
    </Modal>
  );
}

function LinkDetail({ token, onClose, reload }) {
  const { toast } = useApp();
  const [l, re, st] = useLoad(() => get(`/shares/${token}`), [token]);
  const [exp, setExp] = useState('604800000'); const [rev, setRev] = useState(false);
  return (
    <Modal wide title={l ? l.title : 'لینک'} onClose={onClose}>
      <Err error={st.error} retry={re} />
      {!l ? <Spinner /> : <div className="col">
        <div className="row gap wrap"><Badge kind={STATE[l.state]?.[1]}>{STATE[l.state]?.[0] || l.state}</Badge><Badge>{KIND[l.kind]}</Badge><Badge>{n(l.items.length)} فایل · {bytes(l.total)}</Badge><Badge>{n(l.downloads)} دانلود{l.max_dl ? ` از ${n(l.max_dl)}` : ''}</Badge></div>
        {l.rar && l.kind === 'rar' && l.rar_status !== 'ready' && <div className="alert">ساخت RAR: {l.rar_status}{l.rar.pct != null ? ` ${n(l.rar.pct)}٪` : ''}</div>}
        <UrlRow label="لینک اینترنتی" url={l.urls.page} onCopy={(u) => copy(u, toast)} />
        {l.urls.pageLan && !l.urls.pageLan.startsWith('/') && <UrlRow label="لینک شبکه‌ی داخلی" url={l.urls.pageLan} onCopy={(u) => copy(u, toast)} />}
        <div className="muted small">ساخته‌شده {dateTime(l.created)} · {l.expires ? `انقضا ${dateTime(l.expires)}` : 'بدون انقضا'}{l.last_dl ? ` · آخرین دانلود ${ago(l.last_dl)}` : ''}</div>
        <Card title="فایل‌ها"><div style={{ maxHeight: 180, overflowY: 'auto' }}>{l.items.map((it, i) => <div key={i} className="small ltr mono ellipsis">{it.arc || it.path} <span className="muted">({bytes(it.size)})</span></div>)}</div></Card>
        <Card title="آخرین دانلودها">{!l.hits.length ? <Empty>هنوز دانلودی نشده.</Empty> : <table className="tbl"><tbody>{l.hits.map((h) => <tr key={h.id}><td>{dateTime(h.t)}</td><td className="ltr mono">{h.ip}</td><td>{h.status}</td><td>{bytes(h.bytes)}</td></tr>)}</tbody></table>}</Card>
        {l.state !== 'revoked' && <div className="row gap wrap">
          <select value={exp} onChange={(e) => setExp(e.target.value)} style={{ width: 'auto' }}>{EXP.map(([v, x]) => <option key={v} value={v}>{x}</option>)}</select>
          <Btn onClick={async () => { try { await patch(`/shares/${token}`, { expires: exp ? Date.now() + Number(exp) : null }); toast('اعتبار تمدید شد', 'ok'); re(); reload(true); } catch (e) { toast(e.message, 'error'); } }}>تنظیم اعتبار از الان</Btn>
          <Btn kind="danger" onClick={() => setRev(true)}>باطل کردن لینک</Btn>
        </div>}
      </div>}
      {rev && <Confirm danger title="باطل کردن لینک" okText="باطل شود" text="بعد از این، لینک دیگر کار نمی‌کند (دانلودهای در حال انجام هم قطع می‌شوند)." onClose={() => setRev(false)} onOk={async () => { await del(`/shares/${token}`); toast('لینک باطل شد', 'ok'); re(); reload(true); }} />}
    </Modal>
  );
}
const UrlRow = ({ label, url, onCopy }) => <Field label={label}><div className="row gap"><input readOnly value={url} className="ltr mono" onFocus={(e) => e.target.select()} /><Btn kind="sm" icon="copy" onClick={() => onCopy(url)} /><a href={url} target="_blank" rel="noreferrer"><Btn kind="sm ghost" icon="link" /></a></div></Field>;

export default function Links() {
  const loc = useLocation(); const { me } = useApp();
  const sp = new URLSearchParams(loc.search);
  const initial = useMemo(() => ({ m: sp.get('m'), s: sp.get('s'), ss: sp.get('ss') }), []); // eslint-disable-line
  const [all, setAll] = useState(false); const [f, setF] = useState('active');
  const [list, reload, st] = useLoad(() => get(`/shares${q({ all: all ? '1' : '', limit: 300 })}`), [all]);
  const [nw, setNw] = useState(sp.get('new') === '1'); const [open, setOpen] = useState(null);
  const rows = (list || []).filter((l) => f === 'all' || (f === 'active' ? l.state === 'active' : l.state !== 'active'));
  return (
    <div className="stack">
      <div className="page-h"><h2>لینک‌های دانلود</h2><div className="row gap"><Btn kind="primary" icon="plus" onClick={() => setNw(true)}>لینک جدید</Btn><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div></div>
      <div className="row gap wrap"><Tabs value={f} onChange={setF} tabs={[['active', 'فعال'], ['old', 'منقضی/باطل'], ['all', 'همه']]} />{me.owner && <label className="row gap small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> لینک‌های همه‌ی کاربران</label>}</div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : !rows.length ? <Empty>لینکی نیست.</Empty> : <Card pad={false}><div className="card-b list">{rows.map((l) => (
        <div className="li click" key={l.token} onClick={() => setOpen(l.token)}>
          <span className="grow ellipsis">🔗 {l.title}</span>
          <Badge>{KIND[l.kind]}</Badge>
          <Badge kind={STATE[l.state]?.[1]}>{STATE[l.state]?.[0] || l.state}</Badge>
          <span className="muted small hide-sm">{bytes(l.total)} · {n(l.downloads)} دانلود · {l.expires ? `تا ${dateTime(l.expires)}` : 'بدون انقضا'}</span>
        </div>))}</div></Card>}
      {nw && <NewLink initial={initial} onClose={() => setNw(false)} onDone={(l) => { setNw(false); reload(true); setOpen(l.token); }} />}
      {open && <LinkDetail token={open} onClose={() => setOpen(null)} reload={reload} />}
    </div>
  );
}
