import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, get, post } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, KV, Modal, Poster, Spinner, Tabs, Toggle } from '../ui.jsx';
import { bytes, date, dur, n, sxe } from '../fmt.js';

const subBadges = (s) => (!s ? null : <>{(s.have || []).map((x) => <Badge key={'h' + x} kind="ok">💬 {x}</Badge>)}{(s.missing || []).map((x) => <Badge key={'m' + x} kind="warn">بدون {x}</Badge>)}</>);

function Detail({ item, onClose, onDeleted }) {
  const { can, toast } = useApp();
  const nav = useNavigate();
  const isM = item.k === 'm';
  const [d, reload, st] = useLoad(() => get(isM ? `/library/movies/${item.libId}` : `/library/series/${item.libId}`), [item.libId]);
  const [open, setOpen] = useState({});
  const [askDel, setAskDel] = useState(false); const [withFiles, setWithFiles] = useState(false);
  const [askSearch, setAskSearch] = useState(null);
  const folder = d && d.folder;
  const toDrive = (season) => nav(`/drives/copy?${isM ? 'm' : 's'}=${encodeURIComponent(folder)}${season != null ? `&ss=${season}` : ''}`);
  const toLink = (season) => nav(`/links?new=1&${isM ? 'm' : 's'}=${encodeURIComponent(folder)}${season != null ? `&ss=${season}` : ''}`);
  return (
    <Modal wide title={`${isM ? '🎬' : '📺'} ${item.title}${item.year ? ` (${n(item.year)})` : ''}`} onClose={onClose}>
      <Err error={st.error} retry={reload} />
      {!d ? <Spinner /> : <div className="col" style={{ gap: 14 }}>
        <div className="hero">
          <Poster refId={item.ref} title={item.title} className="md" />
          <div className="col grow">
            <div className="chip-row">{(d.genres || []).slice(0, 4).map((g) => <Badge key={g}>{g}</Badge>)}{isM ? (d.hasFile ? <Badge kind="ok">دانلود شده</Badge> : <Badge kind="warn">هنوز فایل ندارد</Badge>) : <Badge kind={d.eps >= d.epTotal && d.epTotal ? 'ok' : 'warn'}>{n(d.eps)} از {n(d.epTotal)} قسمت</Badge>}{d.size > 0 && <Badge>{bytes(d.size)}</Badge>}</div>
            <p className="small" style={{ margin: 0 }}>{d.overview}</p>
            <div className="row gap wrap">
              {can('usb_copy') && folder && <Btn kind="sm" icon="drive" onClick={() => toDrive()}>کپی روی حافظه</Btn>}
              {can('links') && folder && <Btn kind="sm" icon="link" onClick={() => toLink()}>لینک دانلود</Btn>}
              {can('request') && <Btn kind="sm ghost" icon="search" onClick={() => setAskSearch({ season: null })}>جست‌وجوی دوباره</Btn>}
              {can('lib_delete') && <Btn kind="sm ghost" icon="trash" onClick={() => setAskDel(true)}>حذف</Btn>}
            </div>
          </div>
        </div>
        {isM && <Card title="فایل">
          {!d.file ? <Empty>فایلی نیست.</Empty> : <KV rows={[
            ['نام', <span className="ltr mono">{d.file.rel}</span>], ['حجم', bytes(d.file.size)], ['کیفیت', d.file.quality],
            d.file.video && ['ویدیو', `${d.file.video.codec || ''} ${d.file.video.res || ''} ${d.file.video.hdr || ''}`], d.file.video && ['مدت', d.file.video.runtime],
            d.file.video && ['صدا', d.file.video.audio], d.file.video && ['زیرنویس داخلی', d.file.video.subs || '—'],
            ['زیرنویس کنار فایل', d.file.externalSubs.length ? <span className="chip-row">{d.file.externalSubs.map((s) => <Badge key={s.name} kind={s.lang === 'fa' ? 'ok' : ''}>{s.lang || s.name}</Badge>)}</span> : '—'],
            ['وضعیت Bazarr', <span className="chip-row">{subBadges(d.subtitles) || '—'}</span>],
          ]} />}
        </Card>}
        {!isM && <div>{d.seasons.map((s) => (
          <div className="season" key={s.n}>
            <header onClick={() => setOpen({ ...open, [s.n]: !open[s.n] })}>
              <b>{s.n === 0 ? 'ویژه' : `فصل ${n(s.n)}`}</b>
              <Badge kind={s.have === s.total && s.total ? 'ok' : s.have ? 'warn' : ''}>{n(s.have)}/{n(s.total)}</Badge>
              {s.size > 0 && <span className="muted small">{bytes(s.size)}</span>}
              <span className="grow" />
              {s.have > 0 && can('usb_copy') && folder && <Btn kind="sm ghost" icon="drive" onClick={(e) => { e.stopPropagation(); toDrive(s.n); }}>حافظه</Btn>}
              {s.have > 0 && can('links') && folder && <Btn kind="sm ghost" icon="link" onClick={(e) => { e.stopPropagation(); toLink(s.n); }}>لینک</Btn>}
              {can('request') && <Btn kind="sm ghost" icon="search" onClick={(e) => { e.stopPropagation(); setAskSearch({ season: s.n }); }} title="جست‌وجوی دوباره‌ی این فصل" />}
            </header>
            {open[s.n] && s.eps.map((e) => (
              <div className="ep" key={e.id}>
                <span className="mono">{sxe(e.s, e.e)}</span><span className="grow ellipsis">{e.title}</span>
                <span className="muted small">{date(e.air)}</span>
                {e.file ? <Badge kind="ok" title={e.file.path}>{e.file.quality} · {bytes(e.file.size)}</Badge> : <Badge>بدون فایل</Badge>}
                {e.file && (e.file.externalSubs.some((x) => x.lang === 'fa') ? <Badge kind="ok">💬 فارسی</Badge> : <Badge kind="warn">بدون زیرنویس فارسی</Badge>)}
              </div>))}
          </div>))}</div>}
      </div>}
      {askDel && <Confirm title="حذف از کتابخانه" danger okText="حذف" onClose={() => setAskDel(false)} onOk={async () => { try { await del(`/library/${isM ? 'movie' : 'series'}/${item.libId}?deleteFiles=${withFiles ? 1 : 0}`); toast('حذف شد', 'ok'); onDeleted(); } catch (e) { toast(e.message, 'error'); throw e; } }}>
        <p>«{item.title}» از {isM ? 'Radarr' : 'Sonarr'} حذف شود؟</p><Toggle checked={withFiles} onChange={setWithFiles} label="فایل‌ها هم از دیسک پاک شوند" />
      </Confirm>}
      {askSearch && <Confirm title="جست‌وجوی دوباره" okText="شروع جست‌وجو" text={`برای ${askSearch.season != null ? `فصل ${n(askSearch.season)} ` : ''}«${item.title}» دوباره در ایندکسرها جست‌وجو شود؟ اگر نسخه‌ی بهتری پیدا شود، دانلود خودکار شروع می‌شود.`} onClose={() => setAskSearch(null)} onOk={async () => { try { await post(`/library/${isM ? 'movie' : 'series'}/${item.libId}/search`, { season: askSearch.season }); toast('جست‌وجو شروع شد', 'ok'); } catch (e) { toast(e.message, 'error'); throw e; } }} />}
    </Modal>
  );
}

export default function Library() {
  const [k, setK] = useState('movie'); const [f, setF] = useState(''); const [filter, setFilter] = useState('all');
  const [list, reload, st] = useLoad(() => get(`/library?kind=${k}`), [k]);
  const [pick, setPick] = useState(null);
  const shown = useMemo(() => (list || []).filter((x) => (!f || x.title.toLowerCase().includes(f.toLowerCase())) && (filter === 'all' || (filter === 'done' ? (x.k === 'm' ? x.hasFile : x.eps >= x.epTotal && x.epTotal) : (x.k === 'm' ? !x.hasFile : x.eps < x.epTotal)))), [list, f, filter]);
  return (
    <div className="stack">
      <div className="page-h"><h2>کتابخانه</h2><Tabs value={k} onChange={setK} tabs={[['movie', 'فیلم‌ها'], ['series', 'سریال‌ها']]} /></div>
      <div className="row gap wrap"><input type="search" placeholder="فیلتر بر اساس نام…" value={f} onChange={(e) => setF(e.target.value)} style={{ flex: 1, minWidth: 200 }} /><Tabs value={filter} onChange={setFilter} tabs={[['all', 'همه'], ['done', 'کامل'], ['missing', 'ناقص']]} /></div>
      <Err error={st.error} retry={reload} />
      {!list ? <Spinner /> : !shown.length ? <Empty /> : <>
        <span className="muted small">{n(shown.length)} مورد</span>
        <div className="mgrid">{shown.map((it) => (
          <div key={it.libId} className="mcard" onClick={() => setPick(it)}>
            <Poster refId={it.ref} title={it.title} />
            <b className="ellipsis">{it.title}</b>
            <span className="muted row gap">{it.year ? n(it.year) : ''}{it.k === 'm' ? (it.hasFile ? <Badge kind="ok">✓</Badge> : <Badge kind="warn">در انتظار</Badge>) : <Badge kind={it.eps >= it.epTotal && it.epTotal ? 'ok' : 'warn'}>{n(it.eps)}/{n(it.epTotal)}</Badge>}</span>
          </div>))}</div></>}
      {pick && <Detail item={pick} onClose={() => setPick(null)} onDeleted={() => { setPick(null); reload(); }} />}
    </div>
  );
}
