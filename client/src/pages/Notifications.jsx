import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import { Avatar, Empty, Spinner, useToast } from '../ui.jsx';

const LABELS = {
  friend_request: 'sent you a friend request',
  friend_accept: 'accepted your friend request',
  post_like: 'liked your post',
  post_comment: 'commented on your post',
  post_share: 'shared your post',
  new_message: 'sent you a message',
  marketplace_order: 'placed an order',
  order_paid: 'paid for an order',
  order_status: 'updated an order',
  seller_verified: 'seller verification update',
  account_status: 'account status update',
  role_changed: 'your permissions changed',
  report_resolved: 'your report was reviewed',
};

export default function Notifications() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  async function load() {
    try {
      const data = await api.get('/notifications');
      setItems(data.notifications);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function markAll() {
    try {
      await api.post('/notifications/read-all', {});
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
      window.dispatchEvent(new CustomEvent('ash:notifications-changed'));
    } catch (err) {
      toast.push(err.message, 'error');
    }
  }

  if (loading) return <Spinner label="Loading notifications" />;

  return (
    <div className="stack">
      <div className="row between">
        <h1 className="page-title">Notifications</h1>
        {items.some((n) => !n.readAt) ? (
          <button className="btn ghost sm" onClick={markAll}>Mark all read</button>
        ) : null}
      </div>
      {items.length === 0 ? <Empty title="No notifications yet" hint="Friend requests, likes, comments and orders appear here." /> : null}
      <div className="card list">
        {items.map((n) => (
          <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`}>
            {n.actor ? <Avatar user={n.actor} size={38} /> : <div className="avatar placeholder" style={{ width: 38, height: 38 }}>#</div>}
            <div className="grow">
              <div className="notif-text">
                {n.actor ? <Link to={`/u/${n.actor.username}`} className="strong">{n.actor.fullName}</Link> : <span className="strong">#ash Mesh</span>}{' '}
                {LABELS[n.type] || n.type.replaceAll('_', ' ')}
              </div>
              <div className="muted small">{timeAgo(n.createdAt)}</div>
            </div>
            {n.entityType === 'post' && n.entityId ? <Link className="btn ghost sm" to={`/?post=${n.entityId}`}>View</Link> : null}
            {n.entityType === 'listing' && n.entityId ? <Link className="btn ghost sm" to={`/market/${n.entityId}`}>View</Link> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
