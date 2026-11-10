import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Spinner, useToast } from '../ui.jsx';

// Staff-only panel: publish as the official @ashai account and review moderation cases.
// Rendered only when the server confirms staff diagnostics, so ordinary members never see
// controls they cannot use. Every action reports the real server result.
const CATEGORY_OPTIONS = [
  ['announcement', 'Platform announcement'],
  ['education', 'Educational content'],
  ['tech', 'Technology tip'],
  ['islamic', 'Islamic reminder'],
  ['heritage', 'Kano & Nigerian heritage'],
];

export function OfficialPublisher({ onPublished }) {
  const toast = useToast();
  const [category, setCategory] = useState('announcement');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const publish = async (event) => {
    event.preventDefault();
    setError('');
    if (!body.trim()) {
      setError('Write the content before publishing.');
      return;
    }
    setBusy(true);
    try {
      const data = await api('/ai/official/publish', {
        method: 'POST',
        body: { category, body: body.trim() },
      });
      if (!data.published) throw new Error('The server did not confirm publication.');
      toast.push('Published as #ash AI', 'success');
      setBody('');
      if (onPublished) onPublished(data.post);
    } catch (err) {
      setError(err.message || 'Could not publish.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={publish}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Official #ash AI account</h3>
        <Badge tone="green">Staff only</Badge>
      </div>
      <p className="muted small">
        Posts appear in the feed as <strong>@ashai</strong> and are labelled AI-generated. Nothing is published
        until you press the button, and the text below is stored exactly as written.
      </p>
      <label className="small muted" htmlFor="ai-publish-category">Category</label>
      <select
        id="ai-publish-category"
        className="input"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {CATEGORY_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <label className="small muted" htmlFor="ai-publish-body">Content</label>
      <textarea
        id="ai-publish-body"
        className="input"
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Draft the post here. You can generate a draft in the Chat tab first."
      />
      {error ? <div className="error-text">{error}</div> : null}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? 'Publishing…' : 'Publish as #ash AI'}
      </button>
    </form>
  );
}

export function ModerationPanel() {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, staff: false, reviews: [], stats: null, mine: [] });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const mine = await api('/moderation/mine').catch(() => ({ reviews: [], appeals: [] }));
      let queue = null;
      try {
        queue = await api('/moderation/queue');
      } catch {
        queue = null; // 403 for ordinary members: they only see their own notices
      }
      setState({
        loading: false,
        staff: !!queue,
        reviews: queue?.reviews || [],
        stats: queue?.stats || null,
        mine: mine.reviews || [],
      });
    } catch (err) {
      setError(err.message || 'Could not load moderation information.');
      setState((s) => ({ ...s, loading: false }));
    }
  };

  useEffect(() => { load(); }, []);

  const decide = async (reviewId, action) => {
    setError('');
    try {
      await api(`/moderation/reviews/${reviewId}/decide`, { method: 'POST', body: { action, note } });
      toast.push(action === 'approve' ? 'Content restored' : 'Content hidden', 'success');
      setNote('');
      await load();
    } catch (err) {
      setError(err.message || 'Could not save that decision.');
    }
  };

  const appeal = async (reviewId) => {
    setError('');
    try {
      await api(`/moderation/reviews/${reviewId}/appeal`, { method: 'POST', body: { message: note } });
      toast.push('Appeal sent to the moderation team', 'success');
      setNote('');
      await load();
    } catch (err) {
      setError(err.message || 'Could not send the appeal.');
    }
  };

  if (state.loading) return <Spinner label="Loading moderation" />;

  return (
    <div className="stack">
      {error ? <div className="banner warn">{error}</div> : null}

      {state.mine.length ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Your content under review</h3>
          <p className="muted small">
            Content is never deleted automatically. If a decision looks wrong you can appeal it, and a
            moderator will review the original text.
          </p>
          {state.mine.map((review) => (
            <div key={review.id} className="card inner">
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <strong>{review.categoryLabel}</strong>
                <Badge tone={review.status === 'approved' ? 'green' : 'amber'}>{review.status}</Badge>
              </div>
              <div className="small muted">Confidence: {Math.round((review.score || 0) * 100)}%</div>
              <div className="small">{review.contentSnapshot?.slice(0, 240)}</div>
              {review.status !== 'approved' ? (
                <button className="btn small" type="button" onClick={() => appeal(review.id)}>
                  Appeal this decision
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {state.staff ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>Review queue</h3>
            {state.stats ? (
              <Badge tone={state.stats.queue ? 'amber' : 'green'}>
                {state.stats.queue} open · {state.stats.openAppeals} appeals
              </Badge>
            ) : null}
          </div>
          <p className="muted small">
            Findings at or above {Math.round((state.stats?.thresholds?.quarantine || 0.85) * 100)}% are hidden
            from other people until you decide. Nothing is deleted and no account is banned from here.
          </p>
          <label className="small muted" htmlFor="mod-note">Decision note (optional)</label>
          <input
            id="mod-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why you made this decision"
          />
          {state.reviews.length === 0 ? (
            <div className="muted small">Nothing is waiting for review.</div>
          ) : (
            state.reviews.map((review) => (
              <div key={review.id} className="card inner">
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                  <strong>{review.categoryLabel} · {review.targetType}</strong>
                  <Badge tone={review.status === 'quarantine' ? 'red' : 'amber'}>
                    {review.status} · {Math.round((review.score || 0) * 100)}%
                  </Badge>
                </div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{review.contentSnapshot}</div>
                {review.reasons?.length ? (
                  <ul className="plain-list small">{review.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                ) : null}
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn small primary" type="button" onClick={() => decide(review.id, 'approve')}>
                    Restore content
                  </button>
                  <button className="btn small" type="button" onClick={() => decide(review.id, 'remove')}>
                    Hide content
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
