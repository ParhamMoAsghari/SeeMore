import React, { useState } from 'react';
import { post } from '../api.js';
import { useApp } from '../state.jsx';
import { Badge, Btn, Progress } from '../ui.jsx';
import { JOB_KIND, JOB_STATE, bytes, dateTime, dur, n, pct, speed } from '../fmt.js';

const stateKind = (s) => ({ completed: 'ok', failed: 'bad', canceled: 'bad', waiting_for_device: 'warn', paused: 'warn', running: 'pri', verifying: 'pri', committing: 'pri' }[s] || '');
export default function JobCard({ job, onChange, compact }) {
  const { live, toast } = useApp();
  const [busy, setBusy] = useState('');
  const lp = live.progress[job.id];
  const state = (lp && Date.now() - lp.at < 15000 && ['running', 'verifying', 'committing'].includes(job.state) ? lp.state : null) || job.state;
  const total = (job.data && job.data.total) || (lp && lp.total) || 0;
  const done = lp && Date.now() - lp.at < 15000 ? lp.done : job.done || 0;
  const sp = lp ? lp.speed : job.speed || 0;
  const active = ['queued', 'running', 'verifying', 'committing', 'paused', 'waiting_for_device'].includes(state);
  const act = async (what) => { setBusy(what); try { await post(`/jobs/${job.id}/${what}`); toast(what === 'cancel' ? 'لغو شد' : 'ادامه داده شد', 'ok'); onChange && onChange(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); } };
  return (
    <div className="li" style={{ alignItems: 'stretch' }}>
      <div className="grow col" style={{ gap: 6 }}>
        <div className="row gap wrap between">
          <b className="ellipsis grow">{job.title || job.id}</b>
          <Badge kind={stateKind(state)}>{JOB_STATE[state] || state}</Badge>
        </div>
        {(active || state === 'completed') && total > 0 && <Progress value={state === 'completed' ? 100 : pct(done, total)} kind={state === 'completed' ? 'ok' : ''} />}
        <div className="row gap wrap muted small">
          <span>{JOB_KIND[job.kind] || job.kind}</span>
          {total > 0 && <span>{bytes(state === 'completed' ? total : done)} از {bytes(total)} ({n(Math.round(state === 'completed' ? 100 : pct(done, total)))}٪)</span>}
          {['running'].includes(state) && sp > 0 && <span>{speed(sp)} · باقی‌مانده {dur((total - done) / sp)}</span>}
          {lp && lp.cur && active && <span className="ellipsis ltr" style={{ maxWidth: 260 }}>{lp.cur}</span>}
          {!compact && <span>{dateTime(job.created)}</span>}
          {job.attempts > 1 && <span>تلاش {n(job.attempts)}</span>}
          {job.err && <span style={{ color: 'var(--bad)' }}>{job.err}</span>}
          {job.recovery && <Badge title={JSON.stringify(job.recovery)}>بازیابی‌شده</Badge>}
        </div>
      </div>
      {active && <div className="col" style={{ gap: 6, justifyContent: 'center' }}>
        {['paused', 'waiting_for_device', 'failed'].includes(state) && <Btn kind="sm" icon="play" busy={busy === 'resume'} onClick={() => act('resume')}>ادامه</Btn>}
        <Btn kind="ghost sm" icon="x" busy={busy === 'cancel'} onClick={() => act('cancel')}>لغو</Btn>
      </div>}
      {state === 'failed' && <div className="col" style={{ justifyContent: 'center' }}><Btn kind="sm" icon="refresh" busy={busy === 'resume'} onClick={() => act('resume')}>تلاش دوباره</Btn></div>}
    </div>
  );
}
