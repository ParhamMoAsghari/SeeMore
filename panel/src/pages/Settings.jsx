import React, { useMemo, useState } from 'react';
import { del, get, patch, post, put, q } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, Field, Modal, Spinner, Tabs, Toggle } from '../ui.jsx';
import { ago, bytes, dateTime, n } from '../fmt.js';
import { CLS, GROUPS, LABELS, MENU_KEYS, NOTIFY_TYPES } from './settingsMeta.js';

const isOn = (v) => v === true || v === 1 || v === '1' || v === 'true';
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// ---------- apply with confirmation for disruptive classes ----------
function useApply(onDone) {
  const { toast } = useApp();
  const [confirm, setConfirm] = useState(null);
  const describe = (r) => {
    const bad = (r.actions || []).filter((a) => !a.ok);
    if (bad.length) toast(`اعمال نشد: ${bad.map((a) => `${a.type} ${a.target || ''}: ${a.error}${a.reverted ? ' (مقدار قبلی برگشت)' : ''}`).join(' · ')}`, 'error');
    else if (r.unchanged) toast('تغییری نبود');
    else toast((r.actions || []).some((a) => a.type === 'recreate') ? 'ذخیره شد؛ کانتینر در حال ساخت دوباره است — چند ثانیه‌ی دیگر صفحه را تازه کنید' : 'ذخیره و اعمال شد', 'ok');
  };
  async function apply(changes, ok = false) {
    try { const r = await put('/settings', { changes, confirm: ok }); describe(r); onDone && onDone(r); return r; }
    catch (e) { if (e.status === 409 && e.body.needsConfirm) { setConfirm({ changes, plan: e.body.plan }); return null; } toast(e.message, 'error'); throw e; }
  }
  async function rollback(id, ok = false) {
    try { const r = await post(`/settings/history/${id}/rollback`, { confirm: ok }); describe(r); onDone && onDone(r); return r; }
    catch (e) { if (e.status === 409 && e.body.needsConfirm) { setConfirm({ rollback: id, plan: e.body.plan }); return null; } toast(e.message, 'error'); throw e; }
  }
  const modal = confirm && (
    <Confirm danger title="این تغییر سرویس‌ها را جابه‌جا می‌کند" okText="بله، اعمال شود" onClose={() => setConfirm(null)} onOk={() => (confirm.rollback ? rollback(confirm.rollback, true) : apply(confirm.changes, true))}>
      <div className="col">{confirm.plan.map((p) => <div key={p.key} className="li small"><ClsBadge cls={p.cls} /><span className="grow">{LABELS[p.key] || p.key}</span><span className="muted">{CLS[p.cls][2]}{p.target ? ` (${p.target})` : ''}</span></div>)}</div>
    </Confirm>
  );
  return { apply, rollback, modal };
}
const ClsBadge = ({ cls }) => (CLS[cls] ? <Badge kind={CLS[cls][1]} title={CLS[cls][2]}>{CLS[cls][0]}</Badge> : null);

// ---------- one setting input ----------
function Input({ e, value, onChange }) {
  if (e.key === 'bot.menu_hidden' || e.key === 'notify.types') {
    const opts = e.key === 'bot.menu_hidden' ? MENU_KEYS : NOTIFY_TYPES; const cur = csv(value);
    return <div className="chip-row">{opts.map(([k, l]) => <label key={k} className="badge check"><input type="checkbox" checked={cur.includes(k)} onChange={(ev) => onChange((ev.target.checked ? [...cur, k] : cur.filter((x) => x !== k)).join(','))} />{l}</label>)}</div>;
  }
  if (e.key === 'bot.messenger') return <select value={value} onChange={(ev) => onChange(ev.target.value)}><option value="telegram">تلگرام</option><option value="bale">بله</option></select>;
  if (e.type === 'bool') return <Toggle checked={isOn(value)} onChange={(v) => onChange(e.scope === 'subfa' ? (v ? '1' : '0') : v)} />;
  if (e.spec && e.spec.enum) return <select value={value} onChange={(ev) => onChange(ev.target.value)}>{e.spec.enum.map((x) => <option key={x} value={x}>{x}</option>)}</select>;
  if (e.type === 'int' || e.type === 'num') return <input type="number" className="ltr" step={e.type === 'num' ? 'any' : 1} min={e.spec?.min} max={e.spec?.max} value={value ?? ''} onChange={(ev) => onChange(ev.target.value === '' ? '' : Number(ev.target.value))} />;
  return <input className={/^(links|domains|jellyfin|backup|requests\.root|container|usb|ctl)\./.test(e.key) || e.scope !== 'seemore' ? 'ltr' : ''} value={value ?? ''} onChange={(ev) => onChange(ev.target.value)} />;
}
const fmtVal = (e, v) => (e.type === 'bool' ? (isOn(v) ? 'روشن' : 'خاموش') : e.key.startsWith('qbit.') && /limit$/.test(e.key) ? (Number(v) ? `${bytes(v)}/ث` : 'نامحدود') : v === '' || v == null ? '—' : String(v));

function SettingsForm({ entries, reload, note }) {
  const [pending, setPending] = useState({}); const [busy, setBusy] = useState(false);
  const { apply, modal } = useApply(() => { setPending({}); reload(true); });
  const groups = useMemo(() => { const m = new Map(); for (const e of entries) { if (!m.has(e.group)) m.set(e.group, []); m.get(e.group).push(e); } return [...m]; }, [entries]);
  const dirty = Object.keys(pending).length;
  const save = async () => { setBusy(true); try { await apply(Object.entries(pending).map(([key, value]) => ({ key, value }))); } catch {} finally { setBusy(false); } };
  return (
    <div className="stack">
      {note}
      {groups.map(([g, list]) => (
        <Card key={g} title={GROUPS[g] || g}>
          {list.map((e) => e.error ? <div key={e.key} className="alert err">{e.key}: {e.error}</div> : (
            <div key={e.key} className="setting">
              <div className="setting-l">
                <div className="row gap wrap"><b>{LABELS[e.key] || e.description || e.key}</b><ClsBadge cls={e.cls} />{e.overridden && <Badge title="مقدار با پیش‌فرض/فایل env فرق دارد">سفارشی</Badge>}{e.key in pending && <Badge kind="pri">ذخیره نشده</Badge>}</div>
                <div className="muted small ltr" style={{ textAlign: 'left' }}>{e.key}{e.env ? ` · env ${e.env}` : ''}{e.default !== undefined && e.default !== null && e.default !== '' ? ` · default ${fmtVal(e, e.default)}` : ''}</div>
                {LABELS[e.key] && e.description && <div className="muted small">{e.description}</div>}
              </div>
              <div className="setting-c">
                <Input e={e} value={e.key in pending ? (pending[e.key] === null ? (e.default ?? '') : pending[e.key]) : e.value} onChange={(v) => setPending((p) => { const c = { ...p }; if (JSON.stringify(v) === JSON.stringify(e.value)) delete c[e.key]; else c[e.key] = v; return c; })} />
                {e.overridden && e.scope !== 'qbit' && !(e.key in pending) && <button className="link small" onClick={() => setPending({ ...pending, [e.key]: null })}>بازگشت به پیش‌فرض</button>}
              </div>
            </div>))}
        </Card>))}
      {dirty > 0 && <div className="savebar"><span>{n(dirty)} تغییر ذخیره نشده</span><Btn kind="primary" busy={busy} onClick={save}>ذخیره و اعمال</Btn><Btn kind="ghost" onClick={() => setPending({})}>انصراف</Btn></div>}
      {modal}
    </div>
  );
}

// ---------- tabs ----------
const GENERAL = ['features', 'bot', 'notify', 'links', 'panel', 'usb', 'jobs', 'schedule', 'backup', 'acl', 'jellyfin', 'ctl'];
const NETWORK = ['domains', 'net', 'container'];

function CaddyPreview() {
  const [c, re, st] = useLoad(() => get('/settings/caddy'), []);
  return <Card title="پیکربندی Caddy تولیدشده" actions={<Btn kind="sm ghost" icon="refresh" onClick={() => re()} />}><Err error={st.error} />{c && <><div className="muted small ltr">{c.file}{c.current !== c.rendered ? ' · (فایل فعلی با تنظیمات فعلی فرق دارد؛ با ذخیره‌ی یک دامنه یکی می‌شوند)' : ''}</div><pre className="logbox ltr">{c.rendered}</pre></>}</Card>;
}

function Indexers() {
  const { toast } = useApp();
  const [list, reload, st] = useLoad(() => get('/indexers'), []);
  const [add, setAdd] = useState(false); const [testing, setTesting] = useState({}); const [rm, setRm] = useState(null);
  const test = async (i) => { setTesting((t) => ({ ...t, [i.id]: true })); try { const r = await post(`/indexers/${i.id}/test`); toast(r.ok ? `${i.name}: سالم ✅` : `${i.name}: ${r.error}`, r.ok ? 'ok' : 'error'); } finally { setTesting((t) => ({ ...t, [i.id]: false })); } };
  return (
    <div className="stack">
      <div className="row gap"><Btn kind="primary" icon="plus" onClick={() => setAdd(true)}>افزودن ایندکسر</Btn><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : !list.length ? <Empty>ایندکسری نیست.</Empty> : <Card pad={false}><div className="card-b list">{list.map((i) => (
        <div className="li wrap" key={i.id}>
          <Toggle checked={i.enable} onChange={async (v) => { try { await patch(`/indexers/${i.id}`, { enable: v }); reload(true); } catch (e) { toast(e.message, 'error'); } }} />
          <div className="grow col" style={{ gap: 2 }}><b className="ltr" style={{ textAlign: 'right' }}>{i.name}</b><span className="muted small">{i.protocol} · {i.privacy} · اولویت {n(i.priority)}{i.status && i.status.disabledTill ? ` · غیرفعال موقت تا ${dateTime(i.status.disabledTill)}` : ''}</span></div>
          <Btn kind="sm" busy={testing[i.id]} onClick={() => test(i)}>تست</Btn>
          <Btn kind="sm ghost" icon="trash" onClick={() => setRm(i)} />
        </div>))}</div></Card>}
      {add && <AddIndexer onClose={() => setAdd(false)} onDone={() => { setAdd(false); reload(true); }} />}
      {rm && <Confirm danger title="حذف ایندکسر" okText="حذف" text={`«${rm.name}» از Prowlarr حذف شود؟`} onClose={() => setRm(null)} onOk={async () => { await del(`/indexers/${rm.id}`); toast('حذف شد', 'ok'); reload(true); }} />}
    </div>
  );
}
function AddIndexer({ onClose, onDone }) {
  const { toast } = useApp();
  const [term, setTerm] = useState(''); const [res, setRes] = useState(null); const [busy, setBusy] = useState(false);
  const [def, setDef] = useState(null); const [fields, setFields] = useState({});
  const search = async () => { setBusy(true); try { setRes(await get(`/indexers/schema${q({ q: term })}`)); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  const save = async () => { setBusy(true); try { await post('/indexers', { definitionName: def.definitionName, fields }); toast('ایندکسر اضافه شد (Prowlarr آن را تست کرد)', 'ok'); onDone(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  return (
    <Modal wide title="افزودن ایندکسر به Prowlarr" onClose={onClose} footer={def ? <><Btn kind="primary" busy={busy} onClick={save}>افزودن</Btn><Btn kind="ghost" onClick={() => setDef(null)}>بازگشت</Btn></> : null}>
      {!def ? <div className="col">
        <div className="row gap"><input placeholder="نام ایندکسر (مثلاً 1337x)" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} /><Btn icon="search" busy={busy} onClick={search} /></div>
        <div className="list" style={{ maxHeight: '50vh', overflowY: 'auto' }}>{res && (!res.length ? <Empty /> : res.map((x) => <div key={x.definitionName} className="li click" onClick={() => { setDef(x); setFields({}); }}><b className="grow ltr" style={{ textAlign: 'right' }}>{x.name}</b><Badge>{x.privacy}</Badge><Badge>{x.protocol}</Badge><span className="muted small hide-sm">{x.language}</span></div>))}</div>
      </div> : <div className="col">
        <b className="ltr">{def.name}</b><span className="muted small ltr">{def.description}</span>
        {def.fields.filter((f) => !f.advanced && f.type !== 'info' && f.type !== 'hidden').map((f) => (
          <Field key={f.name} label={f.label} hint={f.helpText}>
            {f.type === 'checkbox' ? <Toggle checked={fields[f.name] ?? !!f.value} onChange={(v) => setFields({ ...fields, [f.name]: v })} />
              : f.options ? <select value={fields[f.name] ?? f.value ?? ''} onChange={(e) => setFields({ ...fields, [f.name]: isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value) })}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)}</select>
                : <input className="ltr" type={f.secret || f.type === 'password' ? 'password' : 'text'} placeholder={f.value != null ? String(f.value) : ''} value={fields[f.name] ?? ''} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })} />}
          </Field>))}
      </div>}
    </Modal>
  );
}

function Subtitles({ catalog, reload }) {
  const { toast } = useApp();
  const [list, re, st] = useLoad(() => get('/subtitles/providers'), []);
  const [cfg, setCfg] = useState(null);
  const toggle = async (p, on) => { const next = list.filter((x) => (x.name === p.name ? on : x.enabled)).map((x) => x.name); try { await put('/subtitles/providers/enabled', { providers: next }); toast('ذخیره شد', 'ok'); re(true); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="stack">
      <Card title="منابع زیرنویس Bazarr" actions={<Btn kind="sm ghost" icon="refresh" onClick={() => re()} />}>
        <Err error={st.error} retry={re} />
        {!list ? <Spinner /> : <div className="list">{list.map((p) => (
          <div key={p.name} className="li">
            <Toggle checked={p.enabled} onChange={(v) => toggle(p, v)} />
            <b className="grow ltr" style={{ textAlign: 'right' }}>{p.name}</b>
            {p.status && p.status !== 'Good' && <Badge kind="warn" title={p.retry || ''}>{p.status}</Badge>}
            {p.settings && <Btn kind="sm ghost" onClick={() => setCfg(p)}>تنظیمات</Btn>}
          </div>))}</div>}
      </Card>
      <SettingsForm entries={catalog.filter((e) => e.scope === 'subfa')} reload={reload} note={<p className="muted small">subfa زیرنویس فارسی را برای مواردی که Bazarr پیدا نمی‌کند از subf2m می‌آورد. تغییر این تنظیمات کانتینر subfa را ری‌استارت می‌کند.</p>} />
      {cfg && <ProviderConfig p={cfg} onClose={() => setCfg(null)} onDone={() => { setCfg(null); re(true); }} />}
    </div>
  );
}
function ProviderConfig({ p, onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({});
  return (
    <Confirm title={`تنظیمات ${p.name}`} okText="ذخیره" onClose={onClose} onOk={async () => { try { await patch(`/subtitles/providers/${p.name}`, { fields: f }); toast('ذخیره شد', 'ok'); onDone(); } catch (e) { toast(e.message, 'error'); throw e; } }}>
      <div className="col">{Object.entries(p.settings).map(([k, v]) => (
        <Field key={k} label={k}>{typeof v === 'boolean' ? <Toggle checked={f[k] ?? v} onChange={(x) => setF({ ...f, [k]: x })} /> : <input className="ltr" type={v === '***' ? 'password' : 'text'} placeholder={v === '***' ? 'بدون تغییر' : ''} value={f[k] ?? (v === '***' ? '' : v ?? '')} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>))}</div>
    </Confirm>
  );
}

function Torrent({ catalog, reload }) {
  const { toast } = useApp();
  const [alt, re] = useLoad(() => get('/torrent/alt-speed'), []);
  return (
    <div className="stack">
      <Card title="سرعت جایگزین (لاک‌پشت)"><div className="row gap"><Toggle checked={!!alt} onChange={async () => { try { await post('/torrent/alt-speed/toggle'); re(true); } catch (e) { toast(e.message, 'error'); } }} label={alt ? 'فعال — سقف‌های جایگزین اعمال می‌شوند' : 'خاموش'} /></div></Card>
      <SettingsForm entries={catalog.filter((e) => e.scope === 'qbit')} reload={reload} note={<p className="muted small">سقف‌های سرعت بر حسب بایت بر ثانیه هستند (مثلاً ۱۰ مگابایت = 10485760). صفر یعنی نامحدود.</p>} />
    </div>
  );
}

function Arr({ catalog, reload }) {
  const { toast } = useApp();
  const [pr, , st1] = useLoad(() => get('/arr/profiles'), []);
  const [rf, reRf, st2] = useLoad(() => get('/arr/rootfolders'), []);
  const [np, setNp] = useState({ kind: 'm', path: '' });
  return (
    <div className="stack">
      <SettingsForm entries={catalog.filter((e) => e.group === 'requests')} reload={reload} note={pr && <p className="muted small">کلید کیفیت‌های موجود — فیلم: <span className="ltr">{(pr.keys.m || []).map((x) => `${x.k}→${x.name}`).join(" · ")}</span> · سریال: <span className="ltr">{(pr.keys.s || []).map((x) => `${x.k}→${x.name}`).join(" · ")}</span></p>} />
      <Err error={st1.error || st2.error} />
      <div className="grid g2">
        {['m', 's'].map((k) => (
          <Card key={k} title={k === 'm' ? 'Radarr (فیلم)' : 'Sonarr (سریال)'}>
            <b className="small">پروفایل‌های کیفیت</b>
            {!pr ? <Spinner /> : <div className="chip-row">{pr[k].map((p) => <Badge key={p.id}>{p.name}</Badge>)}</div>}
            <b className="small" style={{ marginTop: 10, display: 'block' }}>پوشه‌های ریشه</b>
            {!rf ? <Spinner /> : rf[k].map((r) => <div key={r.id} className="li small"><span className="grow ltr mono">{r.path}</span><span className="muted">{bytes(r.freeSpace)} آزاد</span>{!r.accessible && <Badge kind="err">در دسترس نیست</Badge>}</div>)}
          </Card>))}
      </div>
      <Card title="افزودن پوشه‌ی ریشه">
        <div className="row gap wrap"><select value={np.kind} onChange={(e) => setNp({ ...np, kind: e.target.value })} style={{ width: 'auto' }}><option value="m">Radarr</option><option value="s">Sonarr</option></select><input className="ltr" placeholder="/data/media/..." value={np.path} onChange={(e) => setNp({ ...np, path: e.target.value })} /><Btn onClick={async () => { try { await post('/arr/rootfolders', np); toast('اضافه شد', 'ok'); setNp({ ...np, path: '' }); reRf(true); } catch (e) { toast(e.message, 'error'); } }}>افزودن</Btn></div>
        <p className="muted small">فقط زیر /data/media مجاز است (همان دیسکی که دانلودها با hardlink به آن منتقل می‌شوند).</p>
      </Card>
    </div>
  );
}

function History() {
  const [list, reload, st] = useLoad(() => get('/settings/history?limit=200'), []);
  const { rollback, modal } = useApply(() => reload(true));
  const [ask, setAsk] = useState(null);
  const S = { applied: ['اعمال شد', 'ok'], pending: ['در انتظار', 'pri'], failed: ['ناموفق', 'err'], reverted: ['برگشت خورد', 'warn'] };
  const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="stack">
      <div className="row gap"><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : !list.length ? <Empty>هنوز تغییری ثبت نشده.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>زمان</th><th>تنظیم</th><th>قبلی</th><th>جدید</th><th>نوع</th><th>وضعیت</th><th /></tr></thead><tbody>{list.map((h) => (
        <tr key={h.id}>
          <td className="nowrap">{dateTime(h.t)}</td><td>{LABELS[h.key] || <span className="ltr">{h.key}</span>}{h.rollback_of ? <span className="muted small"> (برگرداندن #{n(h.rollback_of)})</span> : null}</td>
          <td className="ltr small ellipsis" style={{ maxWidth: 160 }}>{show(h.old)}</td><td className="ltr small ellipsis" style={{ maxWidth: 160 }}>{show(h.new)}</td>
          <td><ClsBadge cls={h.cls} /></td><td><Badge kind={S[h.status]?.[1]} title={h.detail ? JSON.stringify(h.detail) : ''}>{S[h.status]?.[0] || h.status}</Badge></td>
          <td>{h.rollbackable && h.status !== 'failed' && <Btn kind="sm ghost" onClick={() => setAsk(h)}>برگرداندن</Btn>}</td>
        </tr>))}</tbody></table></div>}
      {ask && <Confirm title="برگرداندن تغییر" okText="برگرداندن" text={`مقدار «${LABELS[ask.key] || ask.key}» به ${show(ask.old)} برگردد؟`} onClose={() => setAsk(null)} onOk={() => rollback(ask.id)} />}
      {modal}
    </div>
  );
}

export default function Settings() {
  const [tab, setTab] = useState('general');
  const [cat, reload, st] = useLoad(() => get('/settings'), []);
  const tabs = [['general', 'عمومی'], ['network', 'دامنه و شبکه'], ['arr', 'درخواست / Radarr / Sonarr'], ['indexers', 'ایندکسرها'], ['subs', 'زیرنویس'], ['torrent', 'تورنت'], ['history', 'تاریخچه']];
  return (
    <div className="stack">
      <div className="page-h"><h2>تنظیمات</h2><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <div className="row gap wrap small">{Object.entries(CLS).map(([k, v]) => <span key={k} className="row gap"><Badge kind={v[1]}>{v[0]}</Badge><span className="muted hide-sm">{v[2]}</span></span>)}</div>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <Err error={st.error} retry={reload} />
      {tab === 'indexers' ? <Indexers /> : tab === 'history' ? <History /> : !cat ? <Spinner /> :
        tab === 'general' ? <SettingsForm entries={cat.filter((e) => e.scope === 'seemore' && GENERAL.includes(e.group)).sort((a, b) => GENERAL.indexOf(a.group) - GENERAL.indexOf(b.group))} reload={reload} />
        : tab === 'network' ? <><SettingsForm entries={cat.filter((e) => e.scope === 'seemore' && NETWORK.includes(e.group))} reload={reload} note={<div className="alert">دامنه‌ها از طریق Caddy (گواهی خودکار HTTPS برای دامنه‌های عمومی) سرو می‌شوند. پورت‌ها و حافظه با ساخت دوباره‌ی کانتینر اعمال می‌شوند. فایروال و SSH از این‌جا تغییر نمی‌کنند.</div>} /><CaddyPreview /></>
          : tab === 'arr' ? <Arr catalog={cat} reload={reload} />
            : tab === 'subs' ? <Subtitles catalog={cat} reload={reload} />
              : <Torrent catalog={cat} reload={reload} />}
    </div>
  );
}
