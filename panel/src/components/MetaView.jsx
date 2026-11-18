// Renders the metadata object returned by .../metadata (meta.inspect on the server).
import React from 'react';
import { Badge, Card, KV } from '../ui.jsx';
import { bytes, dateTime, dur, n } from '../fmt.js';

const br = (b) => (b ? `${n(Math.round(b / 1000))} kb/s` : null);
export default function MetaView({ m }) {
  if (!m) return null;
  return (
    <div className="col" style={{ gap: 12 }}>
      <KV rows={[
        ['نام', <span className="ltr">{m.name}</span>], ['نوع', m.isDir ? 'پوشه' : (m.description || m.mime)], ['حجم', m.isDir ? null : bytes(m.size)],
        ['MIME', m.mime && <span className="ltr mono">{m.mime}{m.charset ? `; ${m.charset}` : ''}</span>], ['تغییر', dateTime(m.mtime)], ['ایجاد', m.birthtime ? dateTime(m.birthtime) : null], ['دسترسی', m.modeStr && <span className="ltr mono">{m.modeStr} {m.owner}</span>],
        m.target && ['لینک به', <span className="ltr mono">{m.target}</span>],
      ]} />
      {m.media && <Card title="ویدیو / صدا">
        <KV rows={[['کانتینر', m.media.container], ['مدت', dur(m.media.duration)], ['بیت‌ریت کل', br(m.media.bitrate)], ['عنوان', m.media.title], ['فصل‌بندی', m.media.chapters.length ? n(m.media.chapters.length) : null]]} />
        {m.media.video.map((v, i) => <div key={'v' + i} className="li small"><Badge kind="pri">ویدیو</Badge><span className="ltr">{v.codec} {v.profile || ''} · {v.width}×{v.height} · {v.fps || '?'}fps · {v.bitDepth}bit{v.hdr ? ` · ${v.hdr}` : ''}{v.bitrate ? ` · ${br(v.bitrate)}` : ''}</span></div>)}
        {m.media.audio.map((a, i) => <div key={'a' + i} className="li small"><Badge>صدا</Badge><span className="ltr">{a.lang || 'und'} · {a.codec} · {a.layout || `${a.channels}ch`}{a.title ? ` · ${a.title}` : ''}{a.default ? ' · default' : ''}</span></div>)}
        {m.media.subtitles.map((s, i) => <div key={'s' + i} className="li small"><Badge kind="ok">زیرنویس</Badge><span className="ltr">{s.lang || 'und'} · {s.codec}{s.title ? ` · ${s.title}` : ''}{s.forced ? ' · forced' : ''}</span></div>)}
      </Card>}
      {m.image && <Card title="تصویر"><KV rows={Object.entries(m.image).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v)])} /></Card>}
      {m.pdf && <Card title="PDF"><KV rows={Object.entries(m.pdf).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v)])} /></Card>}
      {m.archive && m.archive.error && <div className="alert warn">{m.archive.error}</div>}{m.archive && !m.archive.error && <Card title="فایل فشرده"><KV rows={[['تعداد فایل', n(m.archive.files ?? m.archive.count)], ['حجم باز‌شده', m.archive.unpacked ? bytes(m.archive.unpacked) : null]]} />{(m.archive.entries || []).slice(0, 30).map((e, i) => <div key={i} className="small ltr mono">{typeof e === 'string' ? e : `${e.name || e.path}${e.size != null ? ` (${bytes(e.size)})` : ''}`}</div>)}</Card>}
      {m.text && <Card title="متن / زیرنویس"><KV rows={Object.entries(m.text).filter(([k, v]) => v !== null && typeof v !== 'object' && k !== 'preview').map(([k, v]) => [k, String(v)])} />{m.text.preview && <pre className="logbox" dir="auto" style={{ maxHeight: 200 }}>{m.text.preview}</pre>}</Card>}
      {m.doc && <Card title="سند"><KV rows={Object.entries(m.doc).map(([k, v]) => [k, String(v)])} /></Card>}
      {m.error && <div className="alert warn">{m.error}</div>}
    </div>
  );
}
