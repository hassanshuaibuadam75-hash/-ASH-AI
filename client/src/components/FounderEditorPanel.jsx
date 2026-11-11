// #ash Mesh — Founder App Editor history panel.
//
// Shows every stored version with its real state (LIVE / draft / tested / superseded),
// lets the Founder preview any version in a new tab, publish a draft, or roll back to an
// earlier version. Rollback creates a new version rather than deleting anything, so it is
// itself reversible.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../ui.jsx';
import { PAGE_ROUTES } from '../siteconfig.jsx';

const STATUS_TEXT = {
  published: 'LIVE',
  draft: 'TEST draft',
  tested: 'Tested draft',
  superseded: 'Earlier version',
};

function when(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}

export default function FounderEditorPanel() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // Publish and rollback are irreversible-looking actions, so they use an explicit inline
  // confirmation instead of window.confirm: it cannot be silently dismissed by the browser
  // and it states exactly which version is affected.
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api('/founder/editor/status');
      setData(res);
    } catch (err) {
      setError(err.message || 'Could not load editor history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(path, body, label, successMessage) {
    setBusy(label);
    setError('');
    try {
      await api(path, { method: 'POST', body: body || {} });
      toast(successMessage);
      await load();
    } catch (err) {
      setError(err.message || 'That action could not be completed.');
    } finally {
      setBusy('');
    }
  }

  function publish(version) {
    setConfirming({ kind: 'publish', version });
  }

  function restore(version) {
    setConfirming({ kind: 'restore', version });
  }

  async function confirmAction() {
    const target = confirming;
    if (!target) return;
    setConfirming(null);
    const { kind, version } = target;
    if (kind === 'publish') {
      await act(`/founder/editor/versions/${version.id}/publish`, {}, `publish-${version.id}`, `Version ${version.number} is live.`);
      return;
    }
    await act(
      `/founder/editor/versions/${version.id}/restore`,
      { publish: true },
      `restore-${version.id}`,
      `Rolled back to version ${version.number}.`
    );
  }

  const versions = (data && data.versions) || [];

  return (
    <div className="card editor-panel">
      <div className="editor-proposal-head">
        <strong>App editor history</strong>
        {data && data.live ? <span className="editor-live-note">LIVE v{data.live.number}</span> : null}
        {data && data.draft ? <span className="editor-live-note">Draft v{data.draft.number}</span> : null}
      </div>

      <p className="muted tiny">
        Changes are proposed in chat, applied to TEST, then published here. Every version is kept, so any change can be
        rolled back.
      </p>

      {error ? <div className="banner danger tiny">{error}</div> : null}
      {loading ? <p className="muted tiny">Loading versions…</p> : null}

      {!loading && versions.length === 0 ? <p className="muted tiny">No versions recorded yet.</p> : null}

      <ul className="editor-version-list">
        {versions.map((version) => {
          const firstPage = (version.changeLog && version.changeLog.length ? 'home' : 'home') || 'home';
          const previewHref = `${PAGE_ROUTES[firstPage] || '/'}?preview=${encodeURIComponent(version.id)}`;
          // Rollback must be possible for every version that is not the one currently live:
          // gating on status === 'published' hid the button for older published versions, so a
          // change that had already gone live could never be reverted from this panel.
          const isLive = !!(data && data.live && data.live.id === version.id);
          return (
            <li key={version.id} className="editor-version">
              <div className="editor-version-head">
                <strong>v{version.number}</strong>
                <span className={`editor-status status-${version.status}`}>{STATUS_TEXT[version.status] || version.status}</span>
                <span className="muted tiny">{when(version.publishedAt || version.createdAt)}</span>
              </div>
              <div className="editor-version-summary">{version.summary || 'No summary'}</div>
              {version.changeLog && version.changeLog.length ? (
                <ul className="editor-changes">
                  {version.changeLog.slice(0, 5).map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {confirming && confirming.version.id === version.id ? (
                <div className="banner warn tiny" role="alertdialog" aria-label="Confirm editor action">
                  <div>
                    {confirming.kind === 'publish'
                      ? `Publish version ${version.number} to LIVE for all users?`
                      : `Roll back to version ${version.number}? This creates a new version and keeps all history.`}
                  </div>
                  <div className="editor-actions">
                    <button type="button" className="btn primary sm" onClick={confirmAction} disabled={!!busy}>
                      {confirming.kind === 'publish' ? `Yes, publish v${version.number}` : `Yes, roll back to v${version.number}`}
                    </button>
                    <button type="button" className="btn ghost sm" onClick={() => setConfirming(null)} disabled={!!busy}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="editor-actions wrap">
                <a className="btn ghost sm" href={previewHref} target="_blank" rel="noreferrer">
                  Preview
                </a>
                {version.status === 'draft' || version.status === 'tested' ? (
                  <button type="button" className="btn primary sm" onClick={() => publish(version)} disabled={!!busy}>
                    {busy === `publish-${version.id}` ? 'Publishing…' : 'Publish to LIVE'}
                  </button>
                ) : null}
                {!isLive ? (
                  <button type="button" className="btn ghost sm" onClick={() => restore(version)} disabled={!!busy}>
                    {busy === `restore-${version.id}` ? 'Restoring…' : 'Roll back to this'}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
