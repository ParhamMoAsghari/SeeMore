import React, { useState } from 'react';
import { post, setCsrf } from '../api.js';
import { useApp } from '../state.jsx';
import { Btn, Field } from '../ui.jsx';
import { n } from '../fmt.js';
import { goNext } from '../oidcnext.js';

export default function Login() {
  const { setMe } = useApp();
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await post('/auth/login', { username: u, password: p }); setCsrf(r.csrf); setMe(r); goNext(); }
    catch (x) {
      if (x.status === 429) setErr(`به‌دلیل تلاش‌های ناموفق، ورود موقتاً قفل شده است. ${n(Math.ceil((x.body.retryAfter || 60) / 60))} دقیقه‌ی دیگر دوباره امتحان کنید.`);
      else if (x.status === 401) setErr('نام کاربری یا رمز عبور درست نیست.');
      else setErr(x.message);
      setP('');
    } finally { setBusy(false); }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="card-b col" style={{ gap: 14 }}>
          <div className="row gap" style={{ justifyContent: 'center', marginBottom: 6 }}><img src="/favicon.svg" width="40" height="40" alt="" /><h2>seemore</h2></div>
          <p className="muted center small" style={{ margin: 0 }}>ورود با همان نام کاربری و رمز سایر سامانه‌ها</p>
          {err && <div className="alert err">{err}</div>}
          <Field label="نام کاربری"><input className="ltr" autoComplete="username" autoCapitalize="none" spellCheck="false" value={u} onChange={(e) => setU(e.target.value)} required autoFocus /></Field>
          <Field label="رمز عبور"><input className="ltr" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></Field>
          <Btn kind="primary" type="submit" busy={busy}>ورود</Btn>
        </div>
      </form>
    </div>
  );
}
