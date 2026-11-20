// Dashboard — the "Groups / Dashboard" destination. Groups are not implemented, so this page
// reports real account activity instead of rendering an empty Groups shell.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Spinner, useToast } from '../ui.jsx';

export default function Dashboard() {
  const toast = useToast();
  const [counters, setCounters] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [nav, me] = await Promise.all([api('/nav/counters'), api('/users/me')]);
      setCounters(nav);
      setProfile(me.user || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  if (!counters && !error) return <div className="center"><Spinner label="Loading dashboard" /></div>;

  const stats = [
    { label: 'Friend requests', value: counters?.friendRequests ?? 0, to: '/friends' },
    { label: 'Unread messages', value: counters?.unreadMessages ?? 0, to: '/messages' },
    { label: 'Unread notifications', value: counters?.unreadNotifications ?? 0, to: '/notifications' },
    { label: 'New videos this week', value: counters?.newVideos ?? 0, to: '/video' },
  ];

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card">
        <div className="card-title">Your activity</div>
        {error ? <div className="small" style={{ color: '#ff9a9a' }}>{error}</div> : null}
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginTop: 8 }}>
          {stats.map((stat) => (
            <Link key={stat.label} to={stat.to} className="card" style={{ padding: 12, textDecoration: 'none' }}>
              <div className="tiny muted">{stat.label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#00ff88' }}>{stat.value}</div>
            </Link>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Groups</div>
        <div className="small muted">
          Groups are not implemented yet. Nothing is shown here because there is no group data to show —
          creating a fake group list would be misleading.
        </div>
      </div>

      <div className="card">
        <div className="card-title">Quick links</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn ghost sm" to="/studio">Creative Studio</Link>
          <Link className="btn ghost sm" to="/ai">#ash AI</Link>
          <Link className="btn ghost sm" to="/market">Marketplace</Link>
          <Link className="btn ghost sm" to="/academy">Academy</Link>
          <Link className="btn ghost sm" to="/heritage">Heritage</Link>
          <Link className="btn ghost sm" to="/settings">Settings</Link>
        </div>
      </div>

      {profile ? (
        <div className="card">
          <div className="card-title">Signed in as</div>
          <div className="small">@{profile.username} · {profile.role}</div>
          <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => { load(); toast.push('Refreshed.', 'success'); }}>
            Refresh
          </button>
        </div>
      ) : null}
    </div>
  );
}
