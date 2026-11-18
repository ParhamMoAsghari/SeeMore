import React, { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, q } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, Field, Modal, Progress, Spinner, Toggle } from '../ui.jsx';
import { bytes, dateTime, n, pct, sxe } from '../fmt.js';
import MediaPicker from '../components/MediaPicker.jsx';
import MetaView from '../components/MetaView.jsx';

const join = (a, b) => (a ? `${a}/${b}` : b);
const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function useDrives() {
  const { live } = useApp();
  const [d, reload, st] = useLoad(() => get('/storage/devices'), []);
  useEffect(() => { if (live.drives) reload(true); }, [live.drives]); // eslint-disable-line
  return [d, reload, st];
}

const FSCK_FA = { clean: '✅ سالم', dirty: '⚠️ قبلاً بدون جداسازی امن جدا شده', repaired: '🛠 تعمیر شد', skipped: 'بررسی نشد', timeout: '⏱ متوقف شد' };
const fsckFa = (r) => (!r ? '' : FSCK_FA[r] || (/^errors/.test(r) ? '❗ خطای فایل‌سیستم (تعمیر نشد)' : r));
// shown only when the drive was not ejected safely (dirty) or has real errors; nothing for a clean drive
const fsckNote = (r) => (r === 'dirty' ? '⚠️ این فلش قبلاً بدون جداسازی امن جدا شده؛ بعداً چک کن.' : /^errors/.test(r || '') ? '❗ فایل‌سیستم این فلش خطا دارد؛ بعداً روی کامپیوتر چکش کن.' : '');

function DriveList() {
  const { can, toast } = useApp();
  const [drives, reload, st] = useDrives();
  const [ej, setEj] = useState(null);
  const [act, setAct] = useState(null); // { kind: 'writable' | 'protected' | 'repair', d }
  const [chk, setChk] = useState(null);
  const owner = can('admin');
  async function check(d) {
    setChk({ d, loading: true });
    try { const r = await post(`/storage/devices/${encodeURIComponent(d.id)}/check`); setChk({ d, ...r }); reload(true); } catch (e) { setChk(null); toast(e.message, 'error'); }
  }
  return (
    <div className="stack">
      <div className="page-h"><h2>حافظه‌های خارجی</h2><div className="row gap">{can('usb_copy') && <Link to="/drives/copy"><Btn kind="primary" icon="copy">کپی از کتابخانه روی حافظه</Btn></Link>}<Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div></div>
      <Err error={st.error} retry={reload} />
      {!drives ? <Spinner /> : !drives.length ? <Empty>هیچ فلش یا هاردی وصل نیست. بعد از وصل کردن، خودکار شناسایی و اینجا نمایش داده می‌شود.</Empty> : <div className="grid g2">{drives.map((d) => (
        <Card key={d.id} title={`💾 ${d.title || d.name}`} actions={<><Badge>{d.fstype}</Badge>{d.protected ? <Badge kind="warn">🔒 محافظت‌شده</Badge> : d.ro ? <Badge kind="warn">فقط‌خواندنی</Badge> : <Badge kind="ok">✏️ قابل نوشتن</Badge>}{fsckNote(d.fsck) && <Badge kind="warn">⚠️ بعداً چک کن</Badge>}{d.busy && <Badge kind="pri">در حال انتقال</Badge>}</>}>
          <div className="col">
            <Progress value={pct(d.total - d.free, d.total)} />
            <span className="muted small">{bytes(d.free)} آزاد از {bytes(d.total)}</span>
            {fsckNote(d.fsck) && <span className="small" style={{ color: 'var(--warn)' }}>{fsckNote(d.fsck)}</span>}
            {d.protected && <span className="small muted">🔒 فقط‌خواندنی: کپی، جابه‌جایی، تغییر نام، ساخت پوشه، حذف و تعمیر روی این حافظه غیرفعال است. مرور، مشخصات، انتقال به سرور و دانلود مجاز است.</span>}
            {d.fstype === 'vfat' && <span className="small" style={{ color: 'var(--warn)' }}>FAT32: فایل‌های بزرگ‌تر از ۴ گیگابایت روی این حافظه جا نمی‌شوند.</span>}
            <div className="row gap wrap">
              <Link to={`/drives/${encodeURIComponent(d.id)}`}><Btn kind="sm" icon="folder">مرور</Btn></Link>
              {can('usb_copy') && !d.ro && <Link to={`/drives/copy?drive=${encodeURIComponent(d.id)}`}><Btn kind="sm" icon="copy">کپی روی این حافظه</Btn></Link>}
              {can('usb_import') && <Link to={`/drives/${encodeURIComponent(d.id)}/import`}><Btn kind="sm" icon="up">انتقال به سرور</Btn></Link>}
              <Btn kind="sm ghost" disabled={d.busy && !d.ro} onClick={() => check(d)}>🩺 بررسی سلامت</Btn>
              {owner && (d.protected
                ? <Btn kind="sm ghost" disabled={d.busy} onClick={() => setAct({ kind: 'writable', d })}>✏️ اجازهٔ نوشتن</Btn>
                : <Btn kind="sm ghost" disabled={d.busy} onClick={() => setAct({ kind: 'protected', d })}>🔒 محافظت‌شده</Btn>)}
              {owner && !d.protected && <Btn kind="sm ghost" disabled={d.busy} onClick={() => setAct({ kind: 'repair', d })}>🛠 تعمیر</Btn>}
              <Btn kind="sm ghost" icon="eject" disabled={d.busy} onClick={() => setEj(d)}>خروج امن</Btn>
            </div>
          </div>
        </Card>))}</div>}
      {chk && <Modal title={`🩺 بررسی سلامت: ${chk.d.title || chk.d.name}`} onClose={() => setChk(null)}>
        {chk.loading ? <><Spinner /><p className="muted small">فقط خواندن؛ هیچ تغییری روی حافظه داده نمی‌شود.</p></> : <>
          <p><b>{chk.label || fsckFa(chk.result)}</b></p>
          {fsckNote(chk.result) && <p className="small">{fsckNote(chk.result)}</p>}
          {chk.log && <pre className="small" dir="ltr" style={{ whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' }}>{chk.log}</pre>}</>}
      </Modal>}
      {act && act.kind === 'writable' && <Confirm danger title="⚠️ اجازهٔ نوشتن" okText="بله، اجازهٔ نوشتن بده" text={`«${act.d.title || act.d.name}» دوباره با امکان نوشتن وصل می‌شود و ربات، پنل و کارهای انتقال می‌توانند روی آن بنویسند، فایل جابه‌جا یا حذف کنند. این تنظیم برای همین حافظه ذخیره می‌شود. اگر اطلاعات مهمی روی آن است و نسخهٔ دیگری ندارد، محافظت را برندارید.`} onClose={() => setAct(null)} onOk={async () => {
        try { await post(`/storage/devices/${encodeURIComponent(act.d.id)}/mode`, { mode: 'writable', confirm: true }); toast('نوشتن مجاز شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; }
      }} />}
      {act && act.kind === 'protected' && <Confirm title="🔒 محافظت از حافظه" okText="محافظت کن" text={`داده‌های در حال نوشتن کامل روی «${act.d.title || act.d.name}» ثبت می‌شوند و حافظه فقط‌خواندنی می‌شود؛ دفعه‌های بعد هم فقط‌خواندنی وصل می‌شود.`} onClose={() => setAct(null)} onOk={async () => {
        try { await post(`/storage/devices/${encodeURIComponent(act.d.id)}/mode`, { mode: 'protected', confirm: true }); toast('حافظه محافظت‌شده شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; }
      }} />}
      {act && act.kind === 'repair' && <Confirm danger title="🛠 تعمیر فایل‌سیستم" okText="بله، تعمیر کن" text={`هشدار جدی: تعمیر ساختار فایل‌سیستم «${act.d.title || act.d.name}» را تغییر می‌دهد و اگر حافظه واقعاً خراب باشد ممکن است بعضی فایل‌ها حذف، کوتاه یا به اسم FSCK*.REC منتقل شوند. اول از اطلاعات مهم نسخهٔ پشتیبان بگیرید. حافظه در طول تعمیر جدا و دوباره وصل می‌شود. فرمت انجام نمی‌شود.`} onClose={() => setAct(null)} onOk={async () => {
        try { const r = await post(`/storage/devices/${encodeURIComponent(act.d.id)}/repair`, { confirm: true }); toast(`نتیجهٔ تعمیر: ${r.label || r.result}`, 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; }
      }} />}
      {ej && <Confirm title="خروج امن" okText="خروج امن" text={`داده‌ها کامل روی «${ej.name}» نوشته و حافظه جدا می‌شود. بعد از پیام موفقیت می‌توانید آن را بیرون بکشید.`} onClose={() => setEj(null)} onOk={async () => {
        try { const r = await post(`/storage/devices/${encodeURIComponent(ej.id)}/eject`); if (r && r.ok === false) throw new Error(r.msg || 'خروج انجام نشد'); toast('حافظه با امنیت جدا شد؛ می‌توانید آن را بیرون بکشید', 'ok'); reload(); } catch (e) { toast(e.message, 'error'); throw e; }
      }} />}
    </div>
  );
}

// folder picker (drive + path) for move / copy destinations
function DestPicker({ drives, start, onPick, onClose, title }) {
  const [drive, setDrive] = useState(start.drive); const [path, setPath] = useState(start.path || '');
  const [ents, reload, st] = useLoad(() => get(`/storage/devices/${encodeURIComponent(drive)}/entries${q({ path })}`), [drive, path]);
  return (
    <Modal title={title} onClose={onClose} footer={<><Btn kind="primary" onClick={() => onPick({ drive, path })}>انتخاب این پوشه</Btn><Btn kind="ghost" onClick={onClose}>انصراف</Btn></>}>
      <div className="col">
        <Field label="حافظه"><select value={drive} onChange={(e) => { setDrive(e.target.value); setPath(''); }}>{drives.filter((d) => !d.ro).map((d) => <option key={d.id} value={d.id}>{d.title || d.name} ({bytes(d.free)} آزاد)</option>)}</select></Field>
        <div className="crumbs"><button onClick={() => setPath('')}>ریشه</button>{path.split('/').filter(Boolean).map((p, i, a) => <React.Fragment key={i}>/<button onClick={() => setPath(a.slice(0, i + 1).join('/'))}>{p}</button></React.Fragment>)}</div>
        <Err error={st.error} retry={reload} />
        <div className="list" style={{ maxHeight: '40vh', overflowY: 'auto' }}>{!ents ? <Spinner /> : ents.filter((e) => e.dir).map((e) => <div className="li click" key={e.name} onClick={() => setPath(join(path, e.name))}>📁 {e.name}</div>)}{ents && !ents.some((e) => e.dir) && <span className="muted small">زیرپوشه‌ای نیست.</span>}</div>
      </div>
    </Modal>
  );
}

function Browser() {
  const { id } = useParams(); const loc = useLocation(); const nav = useNavigate();
  const { can, toast } = useApp();
  const path = new URLSearchParams(loc.search).get('path') || '';
  const go = (p) => nav(`/drives/${encodeURIComponent(id)}${p ? `?path=${encodeURIComponent(p)}` : ''}`);
  const [drives] = useDrives();
  const drive = drives && drives.find((d) => d.id === id);
  const [ents, reload, st] = useLoad(() => get(`/storage/devices/${encodeURIComponent(id)}/entries${q({ path })}`), [id, path]);
  const [meta, setMeta] = useState(null); const [ask, setAsk] = useState(null); const [name, setName] = useState('');
  const [mv, setMv] = useState(null); const [conflict, setConflict] = useState(null);
  const manage = can('usb_manage') && drive && !drive.ro;
  const showMeta = async (e) => { setMeta({ loading: true, name: e.name }); try { setMeta(await get(`/storage/devices/${encodeURIComponent(id)}/metadata${q({ path: join(path, e.name) })}`)); } catch (x) { setMeta(null); toast(x.message, 'error'); } };
  async function transfer(dest, op, mode = 'ask', src = mv) {
    try {
      const r = await post(`/storage/devices/${encodeURIComponent(id)}/move`, { path: src.rel, to: dest.drive, dest: dest.path, op, mode });
      if (r.conflict) { setConflict({ dest, op, src, name: r.conflict }); return; }
      toast(r.done ? 'منتقل شد' : `${op === 'move' ? 'جابه‌جایی' : 'کپی'} در صف قرار گرفت (${n(r.files)} فایل، ${bytes(r.need)})`, 'ok');
      setMv(null); setConflict(null); reload(true);
    } catch (e) { toast(e.message, 'error'); }
  }
  if (drives && !drive) return <div className="stack"><Empty>این حافظه دیگر وصل نیست. <Link to="/drives">بازگشت</Link></Empty></div>;
  return (
    <div className="stack">
      <div className="page-h">
        <h2>💾 {drive ? drive.title || drive.name : '…'}</h2>
        <div className="row gap wrap">
          {manage && <Btn kind="sm" icon="plus" onClick={() => { setAsk({ type: 'mkdir' }); setName(''); }}>پوشه‌ی جدید</Btn>}
          {can('usb_import') && <Link to={`/drives/${encodeURIComponent(id)}/import?path=${encodeURIComponent(path)}`}><Btn kind="sm" icon="up">انتقال این پوشه به سرور</Btn></Link>}
          <Btn kind="ghost sm" icon="refresh" onClick={() => reload()} />
        </div>
      </div>
      {drive && drive.protected && <div className="small muted">🔒 این حافظه محافظت‌شده (فقط‌خواندنی) است؛ کپی روی آن، جابه‌جایی، تغییر نام، ساخت پوشه و حذف غیرفعال است.</div>}
      <div className="crumbs"><button onClick={() => go('')}>ریشه</button>{path.split('/').filter(Boolean).map((p, i, a) => <React.Fragment key={i}>/<button onClick={() => go(a.slice(0, i + 1).join('/'))}>{p}</button></React.Fragment>)}</div>
      <Err error={st.error} retry={reload} />
      <Card pad={false}><div className="card-b">
        {path && <div className="li click" onClick={() => go(parent(path))}>⬆️ <span className="muted">بالا</span></div>}
        {!ents ? <Spinner /> : !ents.length ? <Empty>این پوشه خالی است.</Empty> : <div className="list">{ents.map((e) => (
          <div className="li" key={e.name}>
            <span style={{ cursor: e.dir ? 'pointer' : 'default' }} className="grow ellipsis" onClick={() => (e.dir ? go(join(path, e.name)) : showMeta(e))}>{e.dir ? '📁' : '📄'} {e.name}</span>
            <span className="muted small" style={{ minWidth: 70 }}>{e.dir ? '' : bytes(e.size)}</span>
            <span className="muted small hide-sm">{dateTime(e.mtime)}</span>
            <div className="row">
              <button className="icon-btn" title="مشخصات" onClick={() => showMeta(e)}>ℹ️</button>
              {manage && <button className="icon-btn" title="تغییر نام" onClick={() => { setAsk({ type: 'rename', e }); setName(e.name); }}>✏️</button>}
              {manage && <button className="icon-btn" title="جابه‌جایی / کپی" onClick={() => setMv({ rel: join(path, e.name), name: e.name, op: 'move' })}>✂️</button>}
              {manage && <button className="icon-btn" title="حذف" onClick={() => setAsk({ type: 'delete', e })}>🗑</button>}
            </div>
          </div>))}</div>}
      </div></Card>
      {meta && <Modal wide title={`مشخصات: ${meta.name}`} onClose={() => setMeta(null)}>{meta.loading ? <Spinner /> : <MetaView m={meta} />}</Modal>}
      {ask && ask.type !== 'delete' && <Confirm title={ask.type === 'mkdir' ? 'پوشه‌ی جدید' : 'تغییر نام'} okText="ذخیره" onClose={() => setAsk(null)} onOk={async () => {
        try {
          if (ask.type === 'mkdir') await post(`/storage/devices/${encodeURIComponent(id)}/mkdir`, { path, name });
          else await post(`/storage/devices/${encodeURIComponent(id)}/rename`, { path: join(path, ask.e.name), name });
          toast('انجام شد', 'ok'); reload(true);
        } catch (e) { toast(e.message, 'error'); throw e; }
      }}><Field label="نام"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field></Confirm>}
      {ask && ask.type === 'delete' && <Confirm title="حذف" danger okText="حذف کامل" text={`«${ask.e.name}»${ask.e.dir ? ' و همه‌ی محتوای آن' : ''} از روی حافظه برای همیشه پاک شود؟`} onClose={() => setAsk(null)} onOk={async () => { try { await del(`/storage/devices/${encodeURIComponent(id)}/entries${q({ path: join(path, ask.e.name) })}`); toast('حذف شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; } }} />}
      {mv && !mv.pick && <Modal title={`«${mv.name}»`} onClose={() => setMv(null)} footer={<Btn kind="ghost" onClick={() => setMv(null)}>انصراف</Btn>}>
        <p>این مورد جابه‌جا شود یا یک کپی از آن ساخته شود؟ مقصد می‌تواند روی همین حافظه یا حافظه‌ی دیگری باشد.</p>
        <div className="row gap"><Btn kind="primary" icon="folder" onClick={() => setMv({ ...mv, op: 'move', pick: true })}>جابه‌جایی…</Btn><Btn icon="copy" onClick={() => setMv({ ...mv, op: 'copy', pick: true })}>کپی…</Btn></div>
      </Modal>}
      {mv && mv.pick && drives && <DestPicker title={mv.op === 'move' ? 'مقصد جابه‌جایی' : 'مقصد کپی'} drives={drives} start={{ drive: id, path }} onClose={() => setMv(null)} onPick={(dest) => transfer(dest, mv.op)} />}
      {conflict && <Modal title="نام تکراری" onClose={() => setConflict(null)} footer={<>
        <Btn kind="primary" onClick={() => transfer(conflict.dest, conflict.op, 'keep', conflict.src)}>هر دو بماند</Btn>
        <Btn kind="danger" onClick={() => transfer(conflict.dest, conflict.op, 'overwrite', conflict.src)}>جایگزین شود</Btn>
        <Btn kind="ghost" onClick={() => setConflict(null)}>انصراف</Btn></>}>
        <p>در مقصد «{conflict.name}» از قبل وجود دارد.</p>
      </Modal>}
    </div>
  );
}

function CopyWizard() {
  const loc = useLocation(); const nav = useNavigate(); const { toast } = useApp();
  const sp = new URLSearchParams(loc.search);
  const initial = useMemo(() => ({ m: sp.get('m'), s: sp.get('s'), ss: sp.get('ss') }), []); // eslint-disable-line
  const [drives] = useDrives();
  const [sel, setSel] = useState(null); const [sum, setSum] = useState({ files: 0, size: 0 });
  const [drive, setDrive] = useState(sp.get('drive') || ''); const [folder, setFolder] = useState('');
  const [plan, setPlan] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const writable = (drives || []).filter((d) => !d.ro);
  useEffect(() => { if (!drive && writable.length === 1) setDrive(writable[0].id); }, [drives]); // eslint-disable-line
  useEffect(() => setPlan(null), [sel, drive, folder]);
  const makePlan = async () => { setBusy(true); setErr(null); try { setPlan(await post('/storage/exports/plan', { drive, sel, folder })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const start = async () => { setBusy(true); try { await post('/storage/exports', { drive, sel, folder }); toast('کپی در صف قرار گرفت؛ پیشرفت را در داشبورد یا صفحه‌ی کارها ببینید', 'ok'); nav('/jobs'); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <div className="stack">
      <div className="page-h"><h2>کپی از کتابخانه روی حافظه</h2><Link to="/drives" className="small">بازگشت</Link></div>
      <Card title="۱. انتخاب فیلم‌ها، فصل‌ها یا قسمت‌ها"><MediaPicker initial={initial} onChange={(s, m) => { setSel(s); setSum(m); }} /></Card>
      <Card title="۲. مقصد">
        {!drives ? <Spinner /> : !writable.length ? <Empty>حافظه‌ی قابل‌نوشتنی وصل نیست.</Empty> : <div className="grid g2">
          <Field label="حافظه"><select value={drive} onChange={(e) => setDrive(e.target.value)}><option value="">انتخاب کنید…</option>{writable.map((d) => <option key={d.id} value={d.id}>{d.title || d.name} · {d.fstype} · {bytes(d.free)} آزاد</option>)}</select></Field>
          <Field label="پوشه روی حافظه (اختیاری)" hint="خالی = ریشه. ساختار «سریال/Season XX» حفظ می‌شود."><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="مثلاً Movies" /></Field>
        </div>}
      </Card>
      <Err error={err} />
      {plan && <Card title="۳. خلاصه">
        <KVPlan plan={plan} />
      </Card>}
      <div className="row gap">
        {!plan ? <Btn kind="primary" busy={busy} disabled={!drive || !sum.files} onClick={makePlan}>بررسی فضا و خلاصه</Btn>
          : <Btn kind="primary" busy={busy} disabled={!plan.need || !plan.enough} onClick={start}>شروع کپی</Btn>}
        <span className="muted small">{n(sum.files)} فایل · {bytes(sum.size)}</span>
      </div>
    </div>
  );
}
function KVPlan({ plan }) {
  return (
    <div className="col">
      <div>{plan.title}</div>
      <div className="row gap wrap"><Badge>🎞 {n(plan.videos)} ویدیو</Badge>{plan.subs > 0 && <Badge>💬 {n(plan.subs)} زیرنویس</Badge>}<Badge kind="pri">حجم کپی {bytes(plan.need)}</Badge><Badge>آزاد {bytes(plan.free)}</Badge></div>
      {plan.exists > 0 && <div className="alert">♻️ {n(plan.exists)} فایل با همین حجم از قبل روی حافظه هست و دوباره کپی نمی‌شود.</div>}
      {plan.fat > 0 && <div className="alert warn">⚠️ {n(plan.fat)} فایل بزرگ‌تر از ۴ گیگابایت است و روی FAT32 کپی نمی‌شود (فرمت exFAT یا NTFS لازم است).</div>}
      {!plan.enough && <div className="alert err">⛔ فضای حافظه کافی نیست.</div>}
      {!plan.need && <div className="alert">چیزی برای کپی نمانده است.</div>}
    </div>
  );
}

function ImportWizard() {
  const { id } = useParams(); const loc = useLocation(); const nav = useNavigate(); const { toast } = useApp();
  const [path] = useState(new URLSearchParams(loc.search).get('path') || '');
  const [scan, setScan] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null); const [match, setMatch] = useState(null);
  const initSel = (r) => ({
    movies: Object.fromEntries(r.movies.map((m, i) => [i, { on: !m.needsConfirm && !m.dup, replace: false }])),
    series: Object.fromEntries(r.series.map((s, i) => [i, { on: !s.needsConfirm, replace: false, eps: {} }])),
    other: true, unknownAsOther: true,
  });
  const run = async () => { setBusy(true); setErr(null); try { const r = await post('/storage/imports/scans', { drive: id, path }); setScan(r); setSel(initSel(r)); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const start = async () => { setBusy(true); try { await post('/storage/imports', { scanId: scan.scanId, sel }); toast('انتقال به سرور در صف قرار گرفت', 'ok'); nav('/jobs'); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const setM = (i, p) => setSel((s) => ({ ...s, movies: { ...s.movies, [i]: { ...s.movies[i], ...p } } }));
  const setS = (i, p) => setSel((s) => ({ ...s, series: { ...s.series, [i]: { ...s.series[i], ...p } } }));
  const chosen = sel ? Object.values(sel.movies).filter((x) => x.on).length + Object.values(sel.series).filter((x) => x.on).length : 0;
  return (
    <div className="stack">
      <div className="page-h"><h2>انتقال از حافظه به سرور</h2><Link to={`/drives/${encodeURIComponent(id)}`} className="small">بازگشت</Link></div>
      <Card>
        <p className="small" style={{ marginTop: 0 }}>فیلم‌ها و سریال‌های {path ? <b className="ltr">«{path}»</b> : 'کل حافظه'} شناسایی (اسم فایل + MediaInfo + جست‌وجوی Radarr/Sonarr) و با همان نظم آرشیو از طریق Radarr و Sonarr وارد کتابخانه می‌شوند. موارد تکراری رد می‌شوند و بقیه‌ی فایل‌ها جداگانه در پوشه‌ی «منتقل‌شده از حافظه‌ها» ذخیره می‌شوند. فایل‌های روی حافظه دست نمی‌خورند.</p>
        {!scan && <Btn kind="primary" busy={busy} onClick={run}>شروع بررسی</Btn>}
        {busy && !scan && <p className="muted small">بررسی ممکن است چند دقیقه طول بکشد…</p>}
      </Card>
      <Err error={err} />
      {scan && <>
        <div className="row gap wrap"><Badge>{n(scan.stats.files)} فایل</Badge><Badge>{n(scan.stats.videos)} ویدیو</Badge><Badge>{n(scan.stats.subs)} زیرنویس</Badge><Badge>{n(scan.other.length)} فایل دیگر</Badge><Badge>{n(scan.skipped.length)} ردشده (نمونه/تکراری)</Badge></div>
        <Card title={`🎬 فیلم‌ها (${n(scan.movies.length)})`}>{!scan.movies.length ? <Empty>فیلمی پیدا نشد.</Empty> : <div className="list">{scan.movies.map((m, i) => (
          <div className="li wrap" key={i}>
            <input type="checkbox" checked={!!sel.movies[i].on} onChange={(e) => setM(i, { on: e.target.checked })} />
            <div className="grow col" style={{ gap: 2 }}>
              <span className="ltr small mono ellipsis">{m.file.rel}</span>
              <span>→ <b>{m.match ? `${m.match.title} (${m.match.year || '?'})` : '—'}</b> {m.conf === 'high' ? <Badge kind="ok">مطمئن</Badge> : <Badge kind="warn">نیاز به تأیید</Badge>}{m.why === 'short' && <Badge kind="warn">کوتاه</Badge>}{m.match && m.match.id ? <Badge>در کتابخانه</Badge> : null}</span>
              {m.dup && <span className="small" style={{ color: 'var(--warn)' }}>تکراری: این فیلم با کیفیت {m.dup.quality || '?'} ({bytes(m.dup.size)}) در آرشیو هست. <Toggle checked={sel.movies[i].replace} onChange={(v) => setM(i, { replace: v, on: v || sel.movies[i].on })} label="جایگزین شود" /></span>}
            </div>
            <span className="muted small">{bytes(m.size)}</span>
            <Btn kind="sm ghost" onClick={() => setMatch({ kind: 'movie', index: i, title: m.title || m.match?.title || '' })}>تغییر تطبیق</Btn>
          </div>))}</div>}</Card>
        <Card title={`📺 سریال‌ها (${n(scan.series.length)})`}>{!scan.series.length ? <Empty>سریالی پیدا نشد.</Empty> : <div className="list">{scan.series.map((s, i) => (
          <div className="li wrap" key={i} style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={!!sel.series[i].on} onChange={(e) => setS(i, { on: e.target.checked })} />
            <div className="grow col" style={{ gap: 4 }}>
              <span>«{s.title}» → <b>{s.match ? `${s.match.title} (${s.match.year || '?'})` : '—'}</b> {s.conf === 'high' ? <Badge kind="ok">مطمئن</Badge> : <Badge kind="warn">نیاز به تأیید</Badge>}</span>
              <div className="chip-row">{s.eps.map((e) => { const k = `${e.s}x${e.e[0]}`; const off = sel.series[i].eps[k] === false; return (
                <label key={k} className={`badge check ${e.dup ? 'warn' : ''}`} title={e.rel}><input type="checkbox" checked={!off} onChange={(ev) => setS(i, { eps: { ...sel.series[i].eps, [k]: ev.target.checked ? undefined : false } })} />{sxe(e.s, e.e[0])}{e.dup ? ' (تکراری)' : ''}</label>); })}</div>
              {s.eps.some((e) => e.dup) && <Toggle checked={sel.series[i].replace} onChange={(v) => setS(i, { replace: v })} label="قسمت‌های تکراری جایگزین شوند" />}
            </div>
            <span className="muted small">{bytes(s.size)}</span>
            <Btn kind="sm ghost" onClick={() => setMatch({ kind: 'series', index: i, title: s.title || s.match?.title || '' })}>تغییر تطبیق</Btn>
          </div>))}</div>}</Card>
        {scan.unknown.length > 0 && <Card title={`❓ ناشناخته (${n(scan.unknown.length)})`}><p className="small muted">برای این‌ها تطبیقی پیدا نشد.</p><Toggle checked={sel.unknownAsOther} onChange={(v) => setSel({ ...sel, unknownAsOther: v })} label="به‌عنوان «فایل‌های دیگر» جداگانه ذخیره شوند" /></Card>}
        {scan.other.length > 0 && <Card title={`📎 فایل‌های دیگر (${n(scan.other.length)})`}><Toggle checked={sel.other} onChange={(v) => setSel({ ...sel, other: v })} label="جداگانه در «منتقل‌شده از حافظه‌ها» روی سرور ذخیره شوند" /><div className="small muted ltr" style={{ marginTop: 8 }}>{scan.other.slice(0, 8).map((o) => o.rel).join(' · ')}{scan.other.length > 8 ? ' …' : ''}</div></Card>}
        <div className="row gap"><Btn kind="primary" busy={busy} disabled={!chosen && !sel.other && !sel.unknownAsOther} onClick={start}>تأیید و شروع انتقال</Btn><Btn kind="ghost" onClick={run} busy={busy}>بررسی دوباره</Btn></div>
      </>}
      {match && <MatchModal scanId={scan.scanId} m={match} onClose={() => setMatch(null)} onDone={(item) => {
        setScan((s) => { const c = { ...s }; if (match.kind === 'movie') { c.movies = [...s.movies]; c.movies[match.index] = item; } else { c.series = [...s.series]; c.series[match.index] = item; } return c; });
        if (match.kind === 'movie') setM(match.index, { on: !item.dup }); else setS(match.index, { on: true });
        setMatch(null);
      }} />}
    </div>
  );
}
function MatchModal({ scanId, m, onClose, onDone }) {
  const { toast } = useApp();
  const [term, setTerm] = useState(m.title); const [res, setRes] = useState(null); const [busy, setBusy] = useState(false);
  const search = async () => { setBusy(true); try { setRes(await get(`/storage/imports/candidates${q({ kind: m.kind, term })}`)); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  useEffect(() => { if (term) search(); }, []); // eslint-disable-line
  const pick = async (cand) => { try { onDone(await post(`/storage/imports/scans/${scanId}/rematch`, { kind: m.kind, index: m.index, cand })); toast('تطبیق تغییر کرد', 'ok'); } catch (e) { toast(e.message, 'error'); } };
  return (
    <Modal title="تغییر تطبیق" onClose={onClose}>
      <div className="row gap"><input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} /><Btn icon="search" busy={busy} onClick={search} /></div>
      <div className="list" style={{ marginTop: 10 }}>{!res ? null : !res.length ? <Empty>چیزی پیدا نشد.</Empty> : res.map((c, i) => <div key={i} className="li click" onClick={() => pick(c)}><b className="grow">{c.title}</b><span className="muted">{c.year ? n(c.year) : ''}</span>{c.id ? <Badge kind="ok">در کتابخانه</Badge> : null}</div>)}</div>
    </Modal>
  );
}

export default function Drives() {
  return (
    <Routes>
      <Route index element={<DriveList />} />
      <Route path="copy" element={<CopyWizard />} />
      <Route path=":id" element={<Browser />} />
      <Route path=":id/import" element={<ImportWizard />} />
    </Routes>
  );
}
