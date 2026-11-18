import React, { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { useApp } from '../state.jsx';
import { Badge, Btn, Empty, Err, Field, Modal, Poster, Spinner, Tabs } from '../ui.jsx';
import { n } from '../fmt.js';

function RequestModal({ item, onClose }) {
  const { toast } = useApp();
  const [opts, setOpts] = useState(null); const [q, setQ] = useState('');
  const [mode, setMode] = useState('all'); const [seasons, setSeasons] = useState([]);
  const [busy, setBusy] = useState(false); const [done, setDone] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => {
    Promise.all([get(`/media/qualities?kind=${item.k === 'm' ? 'movie' : 'series'}`), get('/media/request-defaults')])
      .then(([o, d]) => { setOpts(o); const def = item.k === 'm' ? d.m : d.s; setQ((o.find((x) => x.k === def) || o[0] || {}).k || ''); })
      .catch(setErr);
  }, [item]);
  async function go() {
    setBusy(true); setErr(null);
    try {
      const r = await post('/media/requests', { kind: item.k === 'm' ? 'movie' : 'series', key: item.key, quality: q, mode, seasons });
      setDone(r); toast(r.already ? 'از قبل در کتابخانه است' : 'درخواست ثبت شد؛ جست‌وجو و دانلود خودکار شروع می‌شود', 'ok');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const inLib = item.libId > 0;
  return (
    <Modal title={`${item.k === 'm' ? '🎬' : '📺'} ${item.title}${item.year ? ` (${n(item.year)})` : ''}`} onClose={onClose} footer={!done && !inLib ? <>
      <Btn kind="primary" busy={busy} disabled={!opts || !q || (mode === 'sel' && !seasons.length)} onClick={go}>تأیید و شروع دانلود</Btn>
      <Btn kind="ghost" onClick={onClose}>انصراف</Btn></> : <Btn onClick={onClose}>بستن</Btn>}>
      <div className="hero">
        <Poster refId={item.ref} title={item.title} className="md" />
        <div className="col grow">
          <div className="chip-row">{item.genres.slice(0, 4).map((g) => <Badge key={g}>{g}</Badge>)}{item.imdb && <Badge kind="warn">IMDb {n(item.imdb)}</Badge>}{item.rating && <Badge kind="warn">★ {n(item.rating)}</Badge>}{item.k === 's' && item.seasonCount ? <Badge>{n(item.seasonCount)} فصل</Badge> : null}</div>
          <p className="small" style={{ margin: 0 }}>{item.overview || 'خلاصه‌ای موجود نیست.'}</p>
        </div>
      </div>
      <Err error={err} />
      {inLib ? <div className="alert ok" style={{ marginTop: 12 }}>این مورد از قبل در کتابخانه است.</div> : done ? <div className="alert ok" style={{ marginTop: 12 }}>{done.already ? 'از قبل در کتابخانه بود.' : `ثبت شد (کیفیت: ${done.quality}). وضعیت را در صفحه‌ی دانلودها ببینید.`}</div> : (
        <div className="col" style={{ marginTop: 14 }}>
          {!opts ? <Spinner /> : <Field label="کیفیت"><div className="chip-row">{opts.map((o) => <Btn key={o.k} kind={`sm ${q === o.k ? 'primary' : ''}`} onClick={() => setQ(o.k)}>{o.label}</Btn>)}</div></Field>}
          {item.k === 's' && <Field label="کدام فصل‌ها؟">
            <div className="chip-row">{[['all', 'همه‌ی فصل‌ها'], ['last', 'فقط فصل آخر'], ['fut', 'فقط قسمت‌های آینده'], ['sel', 'انتخاب فصل']].map(([k, l]) => <Btn key={k} kind={`sm ${mode === k ? 'primary' : ''}`} onClick={() => setMode(k)}>{l}</Btn>)}</div>
            {mode === 'sel' && <div className="chip-row" style={{ marginTop: 8 }}>{(item.seasons || []).map((s) => <label key={s} className="check badge"><input type="checkbox" checked={seasons.includes(s)} onChange={(e) => setSeasons(e.target.checked ? [...seasons, s] : seasons.filter((x) => x !== s))} />فصل {n(s)}</label>)}</div>}
          </Field>}
        </div>
      )}
    </Modal>
  );
}

export default function Search() {
  const [term, setTerm] = useState(''); const [kind, setKind] = useState('all');
  const [res, setRes] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [pick, setPick] = useState(null);
  async function run(e) {
    e && e.preventDefault(); if (!term.trim()) return;
    setBusy(true); setErr(null);
    try { setRes(await get(`/media/search?term=${encodeURIComponent(term.trim())}&kind=${kind}`)); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <div className="page-h"><h2>جست‌وجو و درخواست</h2></div>
      <form className="row gap wrap" onSubmit={run}>
        <input className="grow" type="search" placeholder="نام فیلم یا سریال (انگلیسی)…" value={term} onChange={(e) => setTerm(e.target.value)} style={{ minWidth: 220, flex: 1 }} />
        <Tabs value={kind} onChange={setKind} tabs={[['all', 'همه'], ['movie', 'فیلم'], ['tv', 'سریال']]} />
        <Btn kind="primary" icon="search" busy={busy} type="submit">جست‌وجو</Btn>
      </form>
      <Err error={err} />
      {res && res.errors.length > 0 && <div className="alert warn">بخشی از نتایج در دسترس نبود ({res.errors.map((e) => (e.k === 'm' ? 'فیلم' : 'سریال')).join('، ')}).</div>}
      {busy && <Spinner label="در حال جست‌وجو… (ممکن است کمی طول بکشد)" />}
      {res && !busy && (!res.items.length ? <Empty>نتیجه‌ای پیدا نشد.</Empty> : <div className="mgrid">{res.items.map((it) => (
        <div key={it.ref} className="mcard" onClick={() => setPick(it)}>
          <Poster refId={it.ref} title={it.title} />
          <b className="ellipsis">{it.title}</b>
          <span className="muted row gap">{it.k === 'm' ? 'فیلم' : 'سریال'} · {it.year ? n(it.year) : '—'}{it.libId > 0 && <Badge kind="ok">در کتابخانه</Badge>}</span>
        </div>))}</div>)}
      {pick && <RequestModal item={pick} onClose={() => setPick(null)} />}
    </div>
  );
}
