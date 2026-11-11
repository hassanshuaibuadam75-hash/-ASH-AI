import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PageIntro } from './siteconfig.jsx';
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import AssistantFab from './components/AssistantFab.jsx';
import { ensureIdentity } from './crypto.js';
import { readCapabilities, describeCapabilities } from './uar.js';
import { Avatar, ToastProvider, useToast, NetworkChip, Spinner } from './ui.jsx';
import AuthPage from './pages/Auth.jsx';
import Menu from './pages/Menu.jsx';
import Feed from './pages/Feed.jsx';
import Profile from './pages/Profile.jsx';
import Friends from './pages/Friends.jsx';
import Messages from './pages/Messages.jsx';
import Market from './pages/Market.jsx';
import AI from './pages/AI.jsx';
import Notifications from './pages/Notifications.jsx';
import Settings from './pages/Settings.jsx';
import Founder from './pages/Founder.jsx';
import Admin from './pages/Admin.jsx';
import Academy from './pages/Academy.jsx';
import Heritage from './pages/Heritage.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Route → site-config page key. Used by the shell to render the editable page intro, so the
// map lives at module scope where both the header and the page body can resolve it.
const PAGE_KEYS = {
  '/': 'home',
  '/market': 'market',
  '/academy': 'academy',
  '/heritage': 'heritage',
  '/messages': 'messages',
  '/friends': 'friends',
  '/settings': 'settings',
  '/menu': 'support',
  '/notifications': 'notifications',
  '/ai': 'ai',
};

// Offline-first session: the last confirmed account is kept on the device so a slow or
// unavailable boot check cannot throw a signed-in user back to the sign-in screen.
const SESSION_CACHE = 'ash_mesh_session_user';

function readCachedUser() {
  try {
    const raw = localStorage.getItem(SESSION_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.id && parsed.username ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user) {
  try {
    if (user) localStorage.setItem(SESSION_CACHE, JSON.stringify(user));
    else localStorage.removeItem(SESSION_CACHE);
  } catch {
    /* storage unavailable (private mode) — session still works for this page */
  }
}

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef(null);
  const toast = useToast();

  const applyUser = useCallback((next) => {
    userRef.current = next || null;
    setUser(next || null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/auth/me');
      const next = data.user || null;
      applyUser(next);
      return next;
    } catch {
      // A failed check is not a sign-out: keep whatever this device already knows.
      return userRef.current;
    }
  }, [applyUser]);

  // A single disagreeing reply must never end a valid session. If the boot check reports
  // "no user" while this device knows an account, confirm against another authenticated
  // endpoint before treating the device as signed out.
  const sessionAlive = useCallback(async () => {
    try {
      await api('/notifications');
      return true;
    } catch (err) {
      return err && err.status === 401 ? false : null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const cached = readCachedUser();
      if (cached && alive) applyUser(cached);
      let verified = await refresh();
      if (!verified && cached) {
        // One retry covers a cold start or a momentary mobile-network stall.
        await new Promise((resolve) => setTimeout(resolve, 700));
        verified = await refresh();
      }
      if (!alive) return;
      if (!verified && cached) {
        const sessionOk = await sessionAlive();
        if (sessionOk === true) verified = cached;
      }
      if (!alive) return;
      // Only a confirmed "no session" while online sends the user back to sign-in.
      if (!verified && cached) applyUser(navigator.onLine === false ? cached : null);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [applyUser, refresh, sessionAlive]);

  useEffect(() => {
    if (user) writeCachedUser(user);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    ensureIdentity().catch(() => toast.push('Encryption keys could not be prepared on this device.', 'error'));
  }, [user, toast]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* session already gone */ }
    writeCachedUser(null);
    applyUser(null);
  }, [applyUser]);

  const value = useMemo(() => ({ user, setUser, loading, refresh, logout }), [user, loading, refresh, logout]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

// Five primary destinations, as approved. Everything else is grouped in Menu so the
// bottom bar never clips on small screens and no feature is removed.
const NAV = [
  { to: '/', label: 'Home', icon: '⌂', end: true },
  { to: '/friends', label: 'Friends', icon: '⚇' },
  { to: '/messages', label: 'Messages', icon: '✉' },
  { to: '/market', label: 'Market', icon: '▤' },
  { to: '/menu', label: 'Menu', icon: '☰' },
];

// Secondary destinations reachable from the sidebar and the Menu page.
const MORE_NAV = [
  { to: '/academy', label: 'Academy', icon: '✎' },
  { to: '/heritage', label: 'Heritage', icon: '◈' },
  { to: '/ai', label: '#ash AI', icon: '✦' },
  { to: '/notifications', label: 'Alerts', icon: '◔' },
];

function Sidebar({ unread }) {
  const { user, logout } = useAuth();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">#</div>
        <div>
          <div className="brand-name">#ash Mesh</div>
          <div className="brand-tag">Your Network. Your Privacy.</div>
        </div>
      </div>
      {NAV.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
          {item.to === '/notifications' && unread > 0 ? <span className="nav-badge">{unread > 9 ? '9+' : unread}</span> : null}
        </NavLink>
      ))}
      <NavLink to={`/u/${user.username}`} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="ico" aria-hidden="true">◉</span><span>My Profile</span>
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="ico" aria-hidden="true">⚙</span><span>Settings</span>
      </NavLink>
      {user.isFounder ? (
        <NavLink to="/founder" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico" aria-hidden="true">★</span><span>Founder Dashboard</span>
        </NavLink>
      ) : null}
      {user.role === 'admin' || user.role === 'moderator' || user.role === 'founder' ? (
        <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico" aria-hidden="true">⛨</span><span>Administration</span>
        </NavLink>
      ) : null}
      <div className="sidebar-foot">
        <div className="row" style={{ padding: '6px 8px' }}>
          <Avatar user={user} size={34} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.fullName}</div>
            <div className="tiny muted">@{user.username}</div>
          </div>
        </div>
        <button className="btn ghost sm" onClick={logout}>Sign out</button>
      </div>
    </aside>
  );
}

function MobileNav({ unread }) {
  const { user } = useAuth();
  return (
    <nav className="mobile-nav">
      {NAV.slice(0, 5).map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
          {item.to === '/notifications' && unread > 0 ? <span className="nav-badge">{unread}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

function Topbar({ unread }) {
  const { user } = useAuth();
  const location = useLocation();
  const [caps, setCaps] = useState(null);
  const [showCaps, setShowCaps] = useState(false);

  useEffect(() => {
    let mounted = true;
    const update = async () => {
      const next = await readCapabilities();
      if (mounted) setCaps(next);
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const timer = setInterval(update, 30000);
    return () => {
      mounted = false;
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      clearInterval(timer);
    };
  }, []);

  const titles = {
    '/': 'Home', '/friends': 'Friends', '/messages': 'Messages', '/market': 'Marketplace',
    '/ai': '#ash AI', '/notifications': 'Notifications', '/settings': 'Settings',
    '/founder': 'Founder Dashboard', '/admin': 'Administration',
  };
  const title = titles[location.pathname] || (location.pathname.startsWith('/u/') ? 'Profile' : '#ash Mesh');
  const label = !caps ? 'Checking network…' : caps.internet ? 'Internet' : caps.wifiAware || caps.ble ? '#ash Nearby' : 'Offline — queued';
  const tone = !caps ? 'amber' : caps.internet ? 'green' : 'amber';

  return (
    <header className="topbar">
      <div className="brand-mark only-mobile" style={{ width: 32, height: 32, fontSize: 16, borderRadius: 10 }}>#</div>
      <h1>{title}</h1>
      <div className="spacer" />
      <button className="btn ghost sm" onClick={() => setShowCaps((v) => !v)} title="Network status">
        <NetworkChip label={label} tone={tone} />
      </button>
      <NavLink to="/notifications" className="btn ghost sm" title="Notifications" style={{ position: 'relative' }}>
        ◔
        {unread > 0 ? <span className="nav-badge" style={{ position: 'absolute', top: -6, right: -6 }}>{unread > 9 ? '9+' : unread}</span> : null}
      </NavLink>
      <NavLink to={`/u/${user.username}`} title="My profile"><Avatar user={user} size={34} /></NavLink>
      {showCaps && caps ? (
        <div className="card" style={{ position: 'absolute', top: 58, right: 14, width: 300, zIndex: 50 }}>
          <div className="card-title">Universal Adaptive Routing</div>
          <div className="stack small muted">
            {describeCapabilities(caps).map((line) => <div key={line}>• {line}</div>)}
          </div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            Routes are selected automatically. The web app uses the internet route and an encrypted offline queue;
            Wi-Fi Aware, Wi-Fi Direct and BLE need the #ash Mesh Android app.
          </div>
        </div>
      ) : null}
    </header>
  );
}

function Shell() {
  const { user, loading } = useAuth();
  const [unread, setUnread] = useState(0);
  const location = useLocation();

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = async () => {
      try {
        const data = await api('/notifications');
        if (alive) setUnread((data.notifications || []).filter((n) => !n.readAt).length);
      } catch { /* ignore */ }
    };
    load();
    const timer = setInterval(load, 45000);
    return () => { alive = false; clearInterval(timer); };
  }, [user, location.pathname]);

  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  // Page slot lookup lives in the shell that actually renders the intro, so the header and
  // the page body always resolve the same page key.
  const introPage = PAGE_KEYS[location.pathname] ||
    (location.pathname.startsWith('/u/') ? 'profile' : null);

  if (loading) {
    return <div className="auth-wrap"><div className="center"><Spinner label="Loading #ash Mesh" /></div></div>;
  }
  if (!user) return <AuthPage />;

  return (
    <div className="app-shell">
      <Sidebar unread={unread} />
      <div className="main-col">
        <Topbar unread={unread} />
        <PageIntro page={introPage} />
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/friends" element={<Friends />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/messages/:id" element={<Messages />} />
          <Route path="/market" element={<Market />} />
          <Route path="/market/:id" element={<Market />} />
          <Route path="/ai" element={<AI />} />
          <Route path="/academy" element={<Academy />} />
          <Route path="/heritage" element={<Heritage />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/menu" element={<Menu />} />
          <Route path="/u/:username" element={<Profile />} />
          <Route path="/founder" element={user.isFounder ? <Founder /> : <Navigate to="/" replace />} />
          <Route path="/admin" element={['admin', 'moderator', 'founder'].includes(user.role) ? <Admin /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <MobileNav unread={unread} />
        <AssistantFab />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ToastProvider>
  );
}
