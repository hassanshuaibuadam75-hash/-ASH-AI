// Search — people discovery backed by the real /api/users/search endpoint.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Avatar, Empty, Spinner } from '../ui.jsx';

const RELATION_LABEL = {
  friends: 'Friends',
  request_sent: 'Request sent',
  request_received: 'Wants to connect',
  blocked: 'Blocked',
  none: '',
};

export default function Search() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  const run = useCallback(async (term) => {
    const value = term.trim();
    if (value.length < 2) {
      setUsers([]);
      setSearched(false);
      return;
    }
    setBusy(true);
    try {
      const data = await api(`/users/search?q=${encodeURIComponent(value)}`);
      setUsers(data.users || []);
      setSearched(true);
    } catch {
      setUsers([]);
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const term = params.get('q') || '';
    setQ(term);
    run(term);
  }, [params, run]);

  function submit(event) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    setParams(next);
  }

  return (
    <div className="stack">
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span className="label">Find people</span>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or @username"
            autoComplete="off"
            maxLength={80}
          />
        </label>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Searching…' : 'Search'}
          </button>
          <span className="tiny muted">Type at least two characters.</span>
        </div>
      </form>

      {busy ? <Spinner label="Searching #ash Mesh" /> : null}

      {!busy && searched && !users.length ? (
        <Empty title="No one found" hint="Try a different name or username." />
      ) : null}

      {users.length ? (
        <div className="card">
          <div className="card-title">People</div>
          <div className="stack" style={{ gap: 4 }}>
            {users.map((person) => (
              <Link key={person.id} to={`/u/${person.username}`} className="row" style={{ padding: '8px 0', gap: 10 }}>
                <Avatar user={person} size={40} />
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{person.displayName || person.username}</div>
                  <div className="tiny muted">@{person.username}</div>
                </span>
                <span className="tiny muted" style={{ marginLeft: 'auto' }}>
                  {RELATION_LABEL[person.relationship] || ''}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
