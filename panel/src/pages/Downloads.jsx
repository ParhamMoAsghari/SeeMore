import React, { useState } from 'react';
import { del, get, post } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Badge, Btn, Card, Confirm, Empty, Err, Progress, Spinner, Toggle } from '../ui.jsx';
import { bytes, dur, n, speed } from '../fmt.js';

export default function Downloads() {
  const { toast } = useApp();
  const [d, reload, st] = useLoad(() => get('/downloads'), [], { interval: 3000 });
  const [rm, setRm] = useState(null); const [block, setBlock] = useState(false);
  const act = async (it, what) => { try { await post(`/downloads/${it.hash}/${what}`); toast(what === 'pause' ? 'متوقف شد' : 'ادامه داده شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="stack">
      <div className="page-h"><h2>دانلودها</h2>{d && d.transfer && <span className="muted">⬇ {speed(d.transfer.dl_info_speed)} · ⬆ {speed(d.transfer.up_info_speed)}</span>}</div>
      <Err error={st.error} retry={reload} />
      {d && d.errors && d.errors.length > 0 && <div className="alert warn">{d.errors.join(' — ')}</div>}
      <Card>
        {!d ? <Spinner /> : !d.items.length ? <Empty>دانلودی در جریان نیست.</Empty> : <div className="list">{d.items.map((it) => (
          <div className="li" key={it.id} style={{ alignItems: 'stretch' }}>
            <div className="grow col" style={{ gap: 6 }}>
              <div className="row gap between wrap"><b className="ellipsis grow">{it.k === 'm' ? '🎬' : '📺'} {it.name}{it.sub ? ` · ${it.sub}` : ''}</b><Badge kind={it.paused ? 'warn' : it.warnings.length ? 'warn' : 'pri'}>{it.state}</Badge></div>
              <Progress value={it.progress} />
              <div className="muted small row gap wrap">
                <span>{n(Math.round(it.progress * 10) / 10)}٪ از {bytes(it.size)}</span>
                {it.speed > 0 && <span>⬇ {speed(it.speed)}</span>}
                {it.eta != null && <span>باقی‌مانده {dur(it.eta)}</span>}{it.etaText && <span>{it.etaText}</span>}
                {it.seeds != null && <span>سید {n(it.seeds)} · پیر {n(it.peers)}</span>}
              </div>
              {it.warnings.map((w, i) => <span key={i} className="small" style={{ color: 'var(--warn)' }}>⚠️ {w}</span>)}
            </div>
            <div className="col" style={{ gap: 6, justifyContent: 'center' }}>
              {it.hash && (it.paused ? <Btn kind="sm" icon="play" onClick={() => act(it, 'resume')}>ادامه</Btn> : <Btn kind="sm" icon="pause" onClick={() => act(it, 'pause')}>توقف</Btn>)}
              {it.hash && <Btn kind="ghost sm" icon="trash" onClick={() => { setRm(it); setBlock(false); }}>حذف</Btn>}
            </div>
          </div>))}</div>}
      </Card>
      {rm && <Confirm title="حذف دانلود" danger okText="حذف" onClose={() => setRm(null)} onOk={async () => { try { await del(`/downloads/${rm.hash.slice(0, 12)}${block ? '?blocklist=1' : ''}`); toast('حذف شد', 'ok'); reload(true); } catch (e) { toast(e.message, 'error'); throw e; } }}>
        <p>«{rm.name}» از صف دانلود و qBittorrent حذف شود؟</p>
        <Toggle checked={block} onChange={setBlock} label="این نسخه در لیست سیاه قرار بگیرد (نسخه‌ی دیگری جست‌وجو شود)" />
      </Confirm>}
    </div>
  );
}
