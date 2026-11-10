import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../App.jsx';
import { Avatar, Badge } from '../ui.jsx';

// Profile / Menu is the fifth primary destination. It groups the features that should stay
// reachable without occupying permanent navigation space. Every entry is a real route that
// already exists in the application; nothing here is decorative.
export default function Menu() {
  const { user, logout } = useAuth();
  if (!user) return null;

  const isStaff = ['admin', 'moderator', 'founder'].includes(user.role);

  const groups = [
    {
      title: 'Your account',
      items: [
        { to: `/u/${user.username}`, label: 'My profile', hint: 'Posts, photos and about you' },
        { to: '/settings', label: 'Edit profile', hint: 'Name, photo, bio and details' },
        { to: '/settings', label: 'Settings & privacy', hint: 'Audience, privacy and notifications' },
        { to: '/notifications', label: 'Notifications', hint: 'Friend requests, likes and messages' },
      ],
    },
    {
      title: 'Learn & culture',
      items: [
        { to: '/academy', label: '#ash Academy', hint: 'Lessons and saved learning' },
        { to: '/heritage', label: '#ash Heritage', hint: 'Kano and Nigerian cultural knowledge' },
      ],
    },
    {
      title: 'Assistant & support',
      items: [
        { to: '/ai', label: '#ash AI', hint: 'Writing, translation and help' },
        { to: '/ai?tab=support', label: 'Help & support', hint: 'Tickets and common questions' },
        { to: '/settings', label: 'Device & offline', hint: 'Offline queue, relay consent and storage' },
      ],
    },
  ];

  if (user.isFounder) {
    groups.push({
      title: 'Founder',
      items: [{ to: '/founder', label: 'Founder Dashboard', hint: 'Platform, marketplace and moderation' }],
    });
  }
  if (isStaff) {
    groups.push({
      title: 'Administration',
      items: [{ to: '/admin', label: 'Administration', hint: 'Reports, moderation and audit log' }],
    });
  }

  return (
    <div className="page">
      <div className="card">
        <div className="row" style={{ gap: 12 }}>
          <Avatar user={user} size={56} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <strong style={{ fontSize: 16 }}>{user.fullName}</strong>
              {user.isFounder ? <Badge tone="green">Founder</Badge> : null}
              {isStaff && !user.isFounder ? <Badge tone="green">{user.role}</Badge> : null}
            </div>
            <div className="tiny muted">@{user.username}</div>
          </div>
          <Link className="btn ghost sm" to={`/u/${user.username}`}>View</Link>
        </div>
      </div>

      {groups.map((group) => (
        <div className="card" key={group.title}>
          <h4 style={{ marginTop: 0 }}>{group.title}</h4>
          <div className="menu-list">
            {group.items.map((item) => (
              <Link className="menu-row" key={`${group.title}-${item.label}`} to={item.to}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{item.label}</div>
                  <div className="tiny muted">{item.hint}</div>
                </div>
                <span aria-hidden="true" className="muted">›</span>
              </Link>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <button className="btn ghost block" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}
