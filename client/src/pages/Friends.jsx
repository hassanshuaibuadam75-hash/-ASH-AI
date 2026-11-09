import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatTime } from '../api.js';
import { Avatar, Empty, Spinner, useToast, Badge, ConfirmDialog } from '../ui.jsx';

export default function Friends() {
  const toast = useToast();
  const [tab, setTab] = useState('friends');
  const [friends, setFriends] = useState(null);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [blocks, setBlocks] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [suggested, setSuggested] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(null);

  const load = useCallback(async () => {
    try {
      const [f, r, b] = await Promise.all([api('/friends'), api('/friends/requests'), api('/blocks')]);
      setFriends(f.friends);
      setRequests(r);
      setBlocks(b.blocks);
    } catch (err) {
      toast.push(err.message, 'error');
      setFriends([]);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api('/users/suggested').then((d) => setSuggested(d.users || [])).catch(() => setSuggested([]));
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return undefined; }
    const timer = setTimeout(async () => {
      try {
        const data = await api(`/users/search?q=${encodeURIComponent(query.trim())}`);
        setResults(data.users || []);
      } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function act(fn, message) {
    setBusy(true);
    try {
      await fn();
      if (message) toast.push(message, 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const requestFriend = (userId) => act(() => api('/friends/request', { method: 'POST', body: { userId } }), 'Friend request sent.');

  if (!friends) return <Spinner label="Loading your network" />;

  const row = (person, right) => (
    <div className="list-row" key={person.id}>
      <Link to={`/u/${person.username}`} className="row" style={{ color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
        <Avatar user={person} size={42} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person.fullName || person.username}</div>
          <div className="tiny muted">@{person.username}{person.verified ? ' · verified' : ''}</div>
        </div>
      </Link>
      <div className="row" style={{ gap: 6 }}>{right}</div>
    </div>
  );

  return (
    <div className="stack">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your network</h2>
        <div className="tabs" role="tablist">
          {[
            ['friends', `Friends (${friends.length})`],
            ['requests', `Requests (${requests.incoming.length})`],
            ['find', 'Find people'],
            ['blocked', `Blocked (${blocks.length})`],
          ].map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      </div>

      {tab === 'friends' ? (
        <div className="card">
          {friends.length === 0 ? <Empty title="No friends yet" hint="Find people and send a friend request." action={<button className="btn primary" onClick={() => setTab('find')}>Find people</button>} /> : null}
          {friends.map((person) => row(person, (
            <>
              <Link className="btn ghost sm" to={`/messages?c=`} onClick={(e) => e.preventDefault()}>Message</Link>
              <button className="btn ghost sm danger-text" disabled={busy} onClick={() => setPendingRemove(person)}>Remove</button>
            </>
          )))}
        </div>
      ) : null}

      {tab === 'requests' ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Incoming</h3>
          {requests.incoming.length === 0 ? <p className="muted small">No incoming requests.</p> : null}
          {requests.incoming.map((request) => row(request.user, (
            <>
              <button className="btn primary sm" disabled={busy} onClick={() => act(() => api(`/friends/${request.requestId}/accept`, { method: 'POST' }), 'Friend request accepted.')}>Accept</button>
              <button className="btn ghost sm" disabled={busy} onClick={() => act(() => api(`/friends/${request.requestId}/reject`, { method: 'POST' }), 'Request rejected.')}>Reject</button>
            </>
          )))}
          <h3>Sent</h3>
          {requests.outgoing.length === 0 ? <p className="muted small">No pending sent requests.</p> : null}
          {requests.outgoing.map((request) => row(request.user, (
            <>
              <Badge tone="grey">Pending · {formatTime(request.createdAt)}</Badge>
              <button className="btn ghost sm" disabled={busy} onClick={() => act(() => api(`/friends/${request.requestId}/cancel`, { method: 'POST' }), 'Request cancelled.')}>Cancel</button>
            </>
          )))}
        </div>
      ) : null}

      {tab === 'find' ? (
        <div className="card">
          <input placeholder="Search by name or @username" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search people" />
          {query.trim() ? (
            results.length === 0 ? <p className="muted small" style={{ marginTop: 12 }}>No accounts matched that search.</p> : results.map((person) => row(person, (
              <button className="btn primary sm" disabled={busy} onClick={() => requestFriend(person.id)}>Add friend</button>
            )))
          ) : (
            <>
              <h3>People you may know</h3>
              {suggested.length === 0 ? <p className="muted small">No suggestions right now.</p> : null}
              {suggested.map((person) => row(person, (
                <button className="btn primary sm" disabled={busy} onClick={() => requestFriend(person.id)}>Add friend</button>
              )))}
            </>
          )}
        </div>
      ) : null}

      {tab === 'blocked' ? (
        <div className="card">
          {blocks.length === 0 ? <p className="muted small">You have not blocked anyone.</p> : null}
          {blocks.map((entry) => row(entry.user, (
            <button className="btn ghost sm" disabled={busy} onClick={() => act(() => api(`/blocks/${entry.user.id}`, { method: 'DELETE' }), 'Unblocked.')}>Unblock</button>
          )))}
        </div>
      ) : null}

      {pendingRemove ? (
        <ConfirmDialog
          title="Remove friend"
          message={`Remove ${pendingRemove.fullName || pendingRemove.username} from your friends? You can send a new request later.`}
          confirmLabel="Remove friend"
          busy={busy}
          onCancel={() => setPendingRemove(null)}
          onConfirm={async () => {
            await act(() => api(`/friends/${pendingRemove.id}`, { method: 'DELETE' }), 'Friend removed.');
            setPendingRemove(null);
          }}
        />
      ) : null}
    </div>
  );
}
