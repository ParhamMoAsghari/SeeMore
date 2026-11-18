import React, { useEffect, useState } from 'react';
import { get } from '../api.js';
import { useApp, useLoad } from '../state.jsx';
import { Card, Empty, Err, Spinner, Tabs } from '../ui.jsx';
import JobCard from '../components/JobCard.jsx';

export default function Jobs() {
  const { live } = useApp();
  const [tab, setTab] = useState('active');
  const [jobs, reload, st] = useLoad(() => get(`/jobs?limit=100${tab === 'active' ? '&active=1' : ''}`), [tab]);
  useEffect(() => { reload(true); }, [live.jobTick]); // eslint-disable-line
  return (
    <div className="stack">
      <div className="page-h"><h2>کارها</h2><Tabs value={tab} onChange={setTab} tabs={[['active', 'در جریان'], ['all', 'همه']]} /></div>
      <Card>
        <Err error={st.error} retry={reload} />
        {!jobs ? <Spinner /> : !jobs.length ? <Empty>کاری نیست.</Empty> : <div className="list">{jobs.map((j) => <JobCard key={j.id} job={j} onChange={() => reload(true)} />)}</div>}
      </Card>
      <p className="muted small">هر کار (کپی، جابه‌جایی، انتقال به آرشیو) در دیتابیس ثبت می‌شود و پس از قطع برق یا جدا شدن حافظه از همان‌جا ادامه پیدا می‌کند. وضعیت‌ها زنده به‌روز می‌شوند.</p>
    </div>
  );
}
