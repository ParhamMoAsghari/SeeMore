import React, { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './state.jsx';
import { Icon, Spinner } from './ui.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Search = lazy(() => import('./pages/Search.jsx'));
const Library = lazy(() => import('./pages/Library.jsx'));
const Downloads = lazy(() => import('./pages/Downloads.jsx'));
const Calendar = lazy(() => import('./pages/Calendar.jsx'));
const Drives = lazy(() => import('./pages/Drives.jsx'));
const Files = lazy(() => import('./pages/Files.jsx'));
const Links = lazy(() => import('./pages/Links.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Health = lazy(() => import('./pages/Health.jsx'));
const Jobs = lazy(() => import('./pages/Jobs.jsx'));

// [path, label, icon, permission]
export const NAV = [
  ['/', 'داشبورد', 'home', null],
  ['/search', 'جست‌وجو و درخواست', 'search', 'request'],
  ['/library', 'کتابخانه', 'film', 'library'],
  ['/downloads', 'دانلودها', 'download', 'downloads'],
  ['/calendar', 'تقویم پخش', 'cal', 'calendar'],
  ['/drives', 'حافظه‌های خارجی', 'drive', 'usb_view'],
  ['/files', 'فایل‌های سرور', 'folder', 'files'],
  ['/links', 'لینک‌های دانلود', 'link', 'links'],
  ['/jobs', 'کارها', 'jobs', null],
  ['/users', 'کاربران و دسترسی‌ها', 'users', 'admin'],
  ['/settings', 'تنظیمات', 'gear', 'admin'],
  ['/health', 'سلامت و لاگ‌ها', 'pulse', 'server'],
];

export default function App() {
  const { me, logout, theme, setTheme, live, can } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (me === undefined) return <div className="boot"><Spinner /></div>;
  if (!me) return <Login />;
  const items = NAV.filter(([, , , p]) => !p || can(p));
  const guard = (p, el) => (!p || can(p) ? el : <Navigate to="/" replace />);
  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="side">
        <div className="brand"><img src="/favicon.svg" alt="" /><b>seemore</b></div>
        <nav>{items.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'on' : '')}><Icon name={icon} /><span>{label}</span></NavLink>)}</nav>
        <div className="side-f">
          <div className="me"><span className={`dot ${live.connected ? 'ok' : 'bad'}`} title={live.connected ? 'اتصال زنده برقرار است' : 'اتصال زنده قطع است'} /><span>{me.username}{me.owner ? ' · مالک' : ''}</span></div>
          <div className="row gap">
            <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="تغییر تم" aria-label="تغییر تم"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
            <button className="icon-btn" onClick={logout} title="خروج" aria-label="خروج"><Icon name="logout" /></button>
          </div>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <main className="main">
        <header className="topbar">
          <button className="icon-btn burger" onClick={() => setOpen(!open)} aria-label="منو"><Icon name="menu" /></button>
          <b className="tb-title">{(NAV.find(([to]) => (to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(to))) || [])[1] || 'seemore'}</b>
          <span className={`dot ${live.connected ? 'ok' : 'bad'}`} />
        </header>
        <div className="content">
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/search" element={guard('request', <Search />)} />
              <Route path="/library/*" element={guard('library', <Library />)} />
              <Route path="/downloads" element={guard('downloads', <Downloads />)} />
              <Route path="/calendar" element={guard('calendar', <Calendar />)} />
              <Route path="/drives/*" element={guard('usb_view', <Drives />)} />
              <Route path="/files" element={guard('files', <Files />)} />
              <Route path="/links" element={guard('links', <Links />)} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/users" element={guard('admin', <Users />)} />
              <Route path="/settings/*" element={guard('admin', <Settings />)} />
              <Route path="/health" element={guard('server', <Health />)} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </div>
        <nav className="bottom">{items.slice(0, 5).map(([to, label, icon]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'on' : '')}><Icon name={icon} /><span>{label.split(' ')[0]}</span></NavLink>)}</nav>
      </main>
    </div>
  );
}
