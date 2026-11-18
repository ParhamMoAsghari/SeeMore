import React, { useState } from 'react';
import { get } from '../api.js';
import { useLoad } from '../state.jsx';
import { Card, Empty, Err, Spinner, Tabs } from '../ui.jsx';
import { dayLabel } from '../fmt.js';

export default function Calendar() {
  const [days, setDays] = useState('14');
  const [c, reload, st] = useLoad(() => get(`/calendar?days=${days}`), [days]);
  return (
    <div className="stack">
      <div className="page-h"><h2>تقویم پخش</h2><Tabs value={days} onChange={setDays} tabs={[['7', 'یک هفته'], ['14', 'دو هفته'], ['30', 'یک ماه']]} /></div>
      <Err error={st.error} retry={reload} />
      {!c ? <Spinner /> : !c.days.length ? <Empty>در این بازه چیزی پخش نمی‌شود.</Empty> : <div className="grid g2">{c.days.map((d) => (
        <Card key={d.when} title={dayLabel(d.when)}><div className="list">{d.lines.map((l, i) => <div className="li" key={i}>{l}</div>)}</div></Card>
      ))}</div>}
      {c && c.errors > 0 && <p className="muted small">بخشی از اطلاعات (Radarr یا Sonarr) در دسترس نبود.</p>}
    </div>
  );
}
