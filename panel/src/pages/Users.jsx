import React, { useState } from 'react';
import { del, get, patch, post, put } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, Field, Modal, Spinner, Tabs } from '../ui.jsx';
import { ago, dateTime, n } from '../fmt.js';

const DUR = [['86400000', '۱ روز'], ['604800000', '۱ هفته'], ['2592000000', '۳۰ روز'], ['7776000000', '۹۰ روز'], ['', 'نامحدود'], ['custom', 'تا تاریخ مشخص…']];
const expOf = (d, custom) => (d === '' ? null : d === 'custom' ? (custom ? new Date(custom).getTime() : null) : Date.now() + Number(d));
const ST = { active: ['فعال', 'ok'], revoked: ['لغو شده', 'err'] };
function stateOf(u) { if (u.status !== 'active') return ST.revoked; if (u.expires && u.expires < Date.now()) return ['منقضی', 'warn']; return ST.active; }

function PermPicker({ perms, value, onChange }) {
  return (
    <div className="col">
      <div className="row gap wrap"><span className="small muted">پیش‌فرض‌ها:</span>{Object.entries(perms.presets).map(([k, v]) => <Btn key={k} kind="sm ghost" onClick={() => onChange(v.slice())}>{{ viewer: 'بیننده', family: 'خانواده', full: 'کامل' }[k] || k}</Btn>)}</div>
      <div className="grid g2">{perms.perms.map(([k, label]) => <label key={k} className="row gap small"><input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />{label}</label>)}</div>
    </div>
  );
}
function DurPicker({ d, setD, custom, setCustom, label = 'مدت دسترسی' }) {
  return <div className="row gap wrap"><Field label={label}><select value={d} onChange={(e) => setD(e.target.value)}>{DUR.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>{d === 'custom' && <Field label="تا"><input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>}</div>;
}

function GrantModal({ perms, user, onClose, onDone }) {
  const { me, toast } = useApp();
  const [uid, setUid] = useState(user ? String(user.uid) : ''); const [name, setName] = useState(user ? user.name || '' : '');
  const [sel, setSel] = useState(user ? user.perms : perms.presets.family.slice());
  const [d, setD] = useState(user ? 'keep' : '2592000000'); const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (user) { const body = { perms: sel }; if (d !== 'keep') body.expires = expOf(d, custom); await patch(`/users/${user.uid}`, body); }
      else await post('/users', { uid: Number(uid), name: name || null, perms: sel, expires: expOf(d, custom) });
      toast('ذخیره شد', 'ok'); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={user ? `ویرایش دسترسی ${user.name || user.uid}` : 'دسترسی جدید'} onClose={onClose} footer={<><Btn kind="primary" busy={busy} disabled={!user && !/^\d+$/.test(uid)} onClick={save}>ذخیره</Btn><Btn kind="ghost" onClick={onClose}>انصراف</Btn></>}>
      <div className="col">
        {!user && <div className="grid g2"><Field label={`شناسه‌ی عددی کاربر در ${me && me.messenger === 'bale' ? 'بله' : 'تلگرام'}`} hint="کاربر می‌تواند با /id در ربات شناسه‌اش را ببیند؛ یا از «لینک دعوت» استفاده کنید."><input inputMode="numeric" className="ltr" value={uid} onChange={(e) => setUid(e.target.value.replace(/\D/g, ''))} /></Field><Field label="نام (اختیاری)"><input value={name} onChange={(e) => setName(e.target.value)} /></Field></div>}
        <PermPicker perms={perms} value={sel} onChange={setSel} />
        {user ? <div className="row gap wrap"><Field label="مدت"><select value={d} onChange={(e) => setD(e.target.value)}><option value="keep">بدون تغییر ({user.expires ? dateTime(user.expires) : 'نامحدود'})</option>{DUR.map(([v, l]) => <option key={v} value={v}>{v === '' ? l : `${l} از الان`}</option>)}</select></Field>{d === 'custom' && <Field label="تا"><input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>}</div>
          : <DurPicker d={d} setD={setD} custom={custom} setCustom={setCustom} />}
        <Err error={err} />
      </div>
    </Modal>
  );
}

function UsersTab({ perms }) {
  const { toast } = useApp();
  const [list, reload, st] = useLoad(() => get('/users'), []);
  const [edit, setEdit] = useState(null); const [ask, setAsk] = useState(null); const [ext, setExt] = useState(null);
  const label = (k) => (perms.perms.find((p) => p[0] === k) || [k, k])[1];
  return (
    <div className="stack">
      <div className="row gap"><Btn kind="primary" icon="plus" onClick={() => setEdit({})}>دسترسی جدید</Btn><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : !list.length ? <Empty>هنوز به کسی دسترسی نداده‌اید.</Empty> : <div className="grid g2">{list.map((u) => { const s = stateOf(u); return (
        <Card key={u.uid} title={`👤 ${u.name || u.username || u.uid}`} actions={<Badge kind={s[1]}>{s[0]}</Badge>}>
          <div className="col small">
            <span className="muted ltr">{u.username ? `@${u.username} · ` : ''}{u.uid}</span>
            <span>{u.expires ? `تا ${dateTime(u.expires)}` : 'بدون انقضا'}{u.last_seen ? ` · آخرین فعالیت ${ago(u.last_seen)}` : ''}</span>
            <div className="chip-row">{u.perms.map((p) => <Badge key={p}>{label(p)}</Badge>)}</div>
            <div className="row gap wrap">
              <Btn kind="sm" onClick={() => setEdit(u)}>ویرایش</Btn>
              <Btn kind="sm ghost" onClick={() => setExt(u)}>تمدید</Btn>
              {u.status === 'active' ? <Btn kind="sm ghost" onClick={() => setAsk({ u, a: 'revoke' })}>لغو دسترسی</Btn> : <Btn kind="sm ghost" onClick={async () => { try { await post('/users', { uid: u.uid, name: u.name, perms: u.perms, expires: u.expires && u.expires > Date.now() ? u.expires : null }); reload(true); } catch (e) { toast(e.message, 'error'); } }}>فعال‌سازی</Btn>}
              <Btn kind="sm danger" onClick={() => setAsk({ u, a: 'remove' })}>حذف</Btn>
            </div>
          </div>
        </Card>); })}</div>}
      {edit && <GrantModal perms={perms} user={edit.uid ? edit : null} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(true); }} />}
      {ext && <ExtendModal u={ext} onClose={() => setExt(null)} onDone={() => { setExt(null); reload(true); }} />}
      {ask && <Confirm danger title={ask.a === 'remove' ? 'حذف کاربر' : 'لغو دسترسی'} okText={ask.a === 'remove' ? 'حذف' : 'لغو دسترسی'} text={ask.a === 'remove' ? 'کاربر و حساب پنل او کامل حذف می‌شود.' : 'کاربر دیگر به ربات و پنل دسترسی ندارد (قابل فعال‌سازی دوباره).'} onClose={() => setAsk(null)} onOk={async () => { try { if (ask.a === 'remove') await del(`/users/${ask.u.uid}`); else await post(`/users/${ask.u.uid}/revoke`); toast('انجام شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; } }} />}
    </div>
  );
}
function ExtendModal({ u, onClose, onDone }) {
  const { toast } = useApp();
  const [d, setD] = useState('2592000000'); const [custom, setCustom] = useState('');
  return (
    <Confirm title={`تمدید دسترسی ${u.name || u.uid}`} okText="تمدید" onClose={onClose} onOk={async () => { try { await post(`/users/${u.uid}/extend`, { expires: expOf(d, custom) }); toast('تمدید شد', 'ok'); onDone(); } catch (e) { toast(e.message, 'error'); throw e; } }}>
      <DurPicker d={d} setD={setD} custom={custom} setCustom={setCustom} label="از الان به مدت" />
    </Confirm>
  );
}

function InvitesTab({ perms }) {
  const { me, toast } = useApp();
  const [list, reload, st] = useLoad(() => get('/invites'), []);
  const [nw, setNw] = useState(false); const [sel, setSel] = useState(perms.presets.family.slice());
  const [d, setD] = useState('2592000000'); const [custom, setCustom] = useState(''); const [ttl, setTtl] = useState('86400000');
  const link = (c) => (me.botUser ? `${me.startLinkBase || 'https://t.me/'}${me.botUser}?start=${c}` : `/start ${c}`);
  const create = async () => {
    try {
      const body = { perms: sel, ttl: Number(ttl) };
      if (d === 'custom') body.grantUntil = expOf(d, custom); else if (d) body.grantDur = Number(d);
      const inv = await post('/invites', body); setNw(false); reload(true);
      navigator.clipboard?.writeText(link(inv.code)).catch(() => {}); toast('لینک دعوت ساخته و کپی شد', 'ok');
    } catch (e) { toast(e.message, 'error'); throw e; }
  };
  return (
    <div className="stack">
      <div className="row gap"><Btn kind="primary" icon="plus" onClick={() => setNw(true)}>لینک دعوت جدید</Btn><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <p className="muted small">لینک دعوت یک‌بار مصرف است؛ هر کس آن را در ربات باز کند همین مجوزها را برای مدت تعیین‌شده می‌گیرد.</p>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : !list.length ? <Empty>دعوت فعالی نیست.</Empty> : <div className="list">{list.map((i) => (
        <div className="li wrap" key={i.code}>
          <span className="grow ltr mono small ellipsis">{link(i.code)}</span>
          <span className="muted small">اعتبار لینک تا {dateTime(i.expires)} · {i.grant_until ? `دسترسی تا ${dateTime(i.grant_until)}` : i.grant_dur ? `دسترسی ${n(Math.round(i.grant_dur / 86400000))} روز` : 'دسترسی نامحدود'} · {n(i.perms.length)} مجوز</span>
          <Btn kind="sm" icon="copy" onClick={() => navigator.clipboard?.writeText(link(i.code)).then(() => toast('کپی شد', 'ok'))} />
          <Btn kind="sm ghost" icon="trash" onClick={async () => { await del(`/invites/${i.code}`); reload(true); }} />
        </div>))}</div>}
      {nw && <Confirm title="لینک دعوت جدید" okText="ساخت" onClose={() => setNw(false)} onOk={create}>
        <div className="col">
          <PermPicker perms={perms} value={sel} onChange={setSel} />
          <DurPicker d={d} setD={setD} custom={custom} setCustom={setCustom} label="مدت دسترسی بعد از ورود" />
          <Field label="اعتبار خود لینک"><select value={ttl} onChange={(e) => setTtl(e.target.value)}><option value="3600000">۱ ساعت</option><option value="86400000">۱ روز</option><option value="604800000">۱ هفته</option></select></Field>
        </div>
      </Confirm>}
    </div>
  );
}

function PanelAccountsTab() {
  const { toast } = useApp();
  const [list, reload, st] = useLoad(() => get('/panel-accounts'), []);
  const [users] = useLoad(() => get('/users'), []);
  const [edit, setEdit] = useState(null); const [rm, setRm] = useState(null);
  return (
    <div className="stack">
      <p className="muted small">ورود مالک با همان نام کاربری و رمز مشترک سیستم (Jellyfin) است. برای کاربرانی که در ربات دسترسی دارند می‌توانید حساب پنل جداگانه بسازید؛ پنل همان مجوزهای ربات را برای آن‌ها اعمال می‌کند.</p>
      <div className="row gap"><Btn kind="primary" icon="plus" onClick={() => setEdit({ username: '', uid: '', password: '' })}>حساب جدید</Btn></div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : <table className="tbl"><thead><tr><th>نام کاربری</th><th>کاربر</th><th>منبع رمز</th><th>آخرین ورود</th><th /></tr></thead><tbody>{list.map((a) => (
        <tr key={a.username}><td className="ltr">{a.username}</td><td className="ltr">{a.uid}</td><td>{a.source === 'env' ? 'رمز مشترک سیستم' : 'رمز اختصاصی'}</td><td>{a.last_login ? ago(a.last_login) : '—'}</td>
          <td>{a.source !== 'env' && <><Btn kind="sm ghost" onClick={() => setEdit({ username: a.username, uid: String(a.uid), password: '', existing: true })}>تغییر رمز</Btn><Btn kind="sm ghost" icon="trash" onClick={() => setRm(a)} /></>}</td></tr>))}</tbody></table>}
      {edit && <Confirm title={edit.existing ? `رمز تازه برای ${edit.username}` : 'حساب پنل جدید'} okText="ذخیره" onClose={() => setEdit(null)} onOk={async () => {
        try { await put(`/panel-accounts/${encodeURIComponent(edit.username)}`, { uid: Number(edit.uid), password: edit.password }); toast('ذخیره شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; }
      }}>
        <div className="col">
          {!edit.existing && <Field label="کاربر ربات"><select value={edit.uid} onChange={(e) => setEdit({ ...edit, uid: e.target.value })}><option value="">انتخاب…</option>{(users || []).filter((u) => u.status === 'active').map((u) => <option key={u.uid} value={u.uid}>{u.name || u.username || u.uid}</option>)}</select></Field>}
          {!edit.existing && <Field label="نام کاربری پنل"><input className="ltr" value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value.toLowerCase() })} /></Field>}
          <Field label="رمز (دست‌کم ۱۰ نویسه)"><input type="password" autoComplete="new-password" className="ltr" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
        </div>
      </Confirm>}
      {rm && <Confirm danger title="حذف حساب پنل" okText="حذف" text={`حساب «${rm.username}» حذف و نشست‌هایش بسته می‌شود (دسترسی ربات دست نمی‌خورد).`} onClose={() => setRm(null)} onOk={async () => { await del(`/panel-accounts/${encodeURIComponent(rm.username)}`); reload(true); }} />}
    </div>
  );
}

function AuditTab() {
  const [list, reload, st] = useLoad(() => get('/audit?limit=300'), []);
  const [users] = useLoad(() => get('/users'), []);
  const who = (uid) => { const u = (users || []).find((x) => x.uid === uid); return u ? u.name || u.username || uid : uid; };
  const [f, setF] = useState('');
  const rows = (list || []).filter((a) => !f || `${a.action} ${a.detail} ${a.perm} ${who(a.uid)}`.toLowerCase().includes(f.toLowerCase()));
  return (
    <div className="stack">
      <div className="row gap"><input type="search" placeholder="فیلتر…" value={f} onChange={(e) => setF(e.target.value)} /><Btn kind="ghost" icon="refresh" onClick={() => reload()} /></div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>زمان</th><th>کاربر</th><th>بخش</th><th>عمل</th><th>جزئیات</th></tr></thead><tbody>{rows.map((a) => <tr key={a.id}><td className="nowrap">{dateTime(a.t)}</td><td>{who(a.uid)}</td><td>{a.perm}</td><td>{a.action}</td><td className="ltr small">{a.detail}</td></tr>)}</tbody></table></div>}
    </div>
  );
}

export function MyAccount() {
  const { me, toast } = useApp();
  const [sess, reload] = useLoad(() => get('/auth/sessions'), []);
  const [pw, setPw] = useState({ current: '', next: '', again: '' }); const [busy, setBusy] = useState(false);
  const change = async () => {
    if (pw.next !== pw.again) return toast('تکرار رمز یکسان نیست', 'error');
    setBusy(true); try { await post('/auth/password', { current: pw.current, next: pw.next }); toast('رمز عوض شد؛ نشست‌های دیگر بسته شدند', 'ok'); setPw({ current: '', next: '', again: '' }); reload(true); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="grid g2">
      <Card title="حساب من">
        <div className="col small"><span>نام کاربری: <b className="ltr">{me.username}</b></span>{me.expires && <span>دسترسی تا {dateTime(me.expires)}</span>}
          {me.owner && <><p className="muted">رمز مالک به‌طور پیش‌فرض همان رمز مشترک سیستم است و با تغییر آن در تنظیمات سرور خودکار به‌روز می‌شود. اگر این‌جا رمز را عوض کنید، رمز اختصاصی پنل می‌شود.</p><Btn kind="sm ghost" onClick={async () => { try { await post('/auth/password/shared'); toast('رمز پنل دوباره همان رمز مشترک سیستم شد', 'ok'); } catch (e) { toast(e.message, 'error'); } }}>بازگشت به رمز مشترک سیستم</Btn></>}
        </div>
      </Card>
      <Card title="تغییر رمز پنل">
        <div className="col">
          <Field label="رمز فعلی"><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="رمز تازه (دست‌کم ۱۰ نویسه)"><input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Field label="تکرار رمز تازه"><input type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></Field>
          <Btn kind="primary" busy={busy} disabled={!pw.current || pw.next.length < 10} onClick={change}>تغییر رمز</Btn>
        </div>
      </Card>
      <Card title="نشست‌های فعال" actions={<Btn kind="sm ghost" onClick={async () => { await del('/auth/sessions'); toast('بقیه‌ی نشست‌ها بسته شدند', 'ok'); reload(true); }}>بستن بقیه</Btn>}>
        {!sess ? <Spinner /> : <div className="list">{sess.map((s) => <div className="li small" key={s.id}><span className="grow ellipsis ltr">{s.ua || '?'}</span><span className="ltr mono">{s.ip}</span><span className="muted">{ago(s.last_seen)}</span></div>)}</div>}
      </Card>
    </div>
  );
}

export default function Users() {
  const { me } = useApp();
  const [tab, setTab] = useState(me.owner ? 'users' : 'me');
  const [perms] = useLoad(() => get('/permissions'), []);
  const tabs = me.owner ? [['users', 'کاربران'], ['invites', 'دعوت‌ها'], ['panel', 'حساب‌های پنل'], ['audit', 'گزارش فعالیت'], ['me', 'حساب من']] : [['me', 'حساب من']];
  return (
    <div className="stack">
      <div className="page-h"><h2>{me.owner ? 'کاربران و دسترسی‌ها' : 'حساب من'}</h2></div>
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
      {tab === 'me' ? <MyAccount /> : !perms ? <Spinner /> : tab === 'users' ? <UsersTab perms={perms} /> : tab === 'invites' ? <InvitesTab perms={perms} /> : tab === 'panel' ? <PanelAccountsTab /> : <AuditTab />}
    </div>
  );
}
