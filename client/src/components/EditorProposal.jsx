// #ash Mesh — Founder App Editor proposal card, rendered inside the @ashai conversation.
//
// The card is the approval gate: nothing here happens automatically. It shows exactly what
// would change, offers a real preview of the affected page, and only the explicit
// "Apply changes" action writes a TEST draft. Publishing to LIVE is a separate, confirmed
// step. Every state shown comes from the server, never from optimistic UI.
import React, { useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../ui.jsx';
import { PAGE_ROUTES } from '../siteconfig.jsx';

const STATUS_LABELS = {
  proposed: 'Proposed — nothing has been applied',
  applied: 'Applied to TEST (draft) — not live yet',
  cancelled: 'Cancelled — no change was made',
};

function pageHref(pages) {
  const first = Array.isArray(pages) && pages.length ? pages[0] : 'home';
  return PAGE_ROUTES[first] || '/';
}

export default function EditorProposal({ initial }) {
  const toast = useToast();
  const [proposal, setProposal] = useState(initial);
  const [version, setVersion] = useState(null);
  const [liveVersion, setLiveVersion] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  if (!proposal) return null;

  const status = proposal.status;
  const draftId = proposal.versionId;

  async function call(path, body, label) {
    setBusy(label);
    setError('');
    try {
      const data = await api(path, body ? { method: 'POST', body } : undefined);
      if (data && data.proposal) setProposal(data.proposal);
      if (data && data.version) setVersion(data.version);
      if (data && data.live) setLiveVersion(data.live);
      if (data && data.config && data.version) {
        // Preview page picked up a fresh draft: reload so the provider re-reads it.
      }
      return data;
    } catch (err) {
      setError(err.message || 'That action could not be completed.');
      return null;
    } finally {
      setBusy('');
    }
  }

  async function apply() {
    const data = await call(`/founder/editor/proposals/${proposal.id}/apply`, {}, 'apply');
    if (data) toast('Applied to TEST. Review the preview, then publish to LIVE.');
  }

  async function cancel() {
    const data = await call(`/founder/editor/proposals/${proposal.id}/cancel`, {}, 'cancel');
    if (data) toast('Proposal cancelled. Nothing changed.');
  }

  async function markTested() {
    if (!draftId) return;
    const data = await call(`/founder/editor/versions/${draftId}/tested`, {}, 'tested');
    if (data) toast('Draft marked as tested.');
  }

  async function publish() {
    if (!draftId) return;
    if (!window.confirm('Publish this change to LIVE for all #ash Mesh users?')) return;
    const data = await call(`/founder/editor/versions/${draftId}/publish`, {}, 'publish');
    if (data && data.version) toast(`Published to LIVE as version ${data.version.number}.`);
  }

  const previewHref = draftId ? `${pageHref(proposal.pages)}?preview=${encodeURIComponent(draftId)}` : null;

  return (
    <div className="card editor-proposal">
      <div className="editor-proposal-head">
        <span className="badge ai-badge">Founder editor</span>
        <span className={`editor-status status-${status}`}>{STATUS_LABELS[status] || status}</span>
      </div>

      <p className="editor-proposal-summary">{proposal.summary}</p>

      {proposal.changeLog && proposal.changeLog.length ? (
        <ul className="editor-changes">
          {proposal.changeLog.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}

      {error ? <div className="banner danger tiny">{error}</div> : null}

      {status === 'proposed' ? (
        <div className="editor-actions">
          <button type="button" className="btn primary sm" onClick={apply} disabled={!!busy}>
            {busy === 'apply' ? 'Applying…' : 'Apply changes'}
          </button>
          <button type="button" className="btn ghost sm" onClick={cancel} disabled={!!busy}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      ) : null}

      {status === 'applied' ? (
        <div className="editor-actions wrap">
          {previewHref ? (
            <a className="btn ghost sm" href={previewHref} target="_blank" rel="noreferrer">
              Preview page
            </a>
          ) : null}
          {version && version.status === 'draft' ? (
            <button type="button" className="btn ghost sm" onClick={markTested} disabled={!!busy}>
              {busy === 'tested' ? 'Saving…' : 'Mark as tested'}
            </button>
          ) : null}
          {version && version.status !== 'published' ? (
            <button type="button" className="btn primary sm" onClick={publish} disabled={!!busy}>
              {busy === 'publish' ? 'Publishing…' : 'Publish to LIVE'}
            </button>
          ) : null}
          {version && version.status === 'published' ? (
            <span className="editor-live-note">Live as version {version.number}</span>
          ) : null}
        </div>
      ) : null}

      {status === 'cancelled' ? <p className="muted tiny">No change was written to the application.</p> : null}
      {liveVersion ? <p className="muted tiny">Current LIVE version: {liveVersion.number}</p> : null}
    </div>
  );
}
