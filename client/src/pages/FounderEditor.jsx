// #ash Mesh — Founder Editor page (Founder Dashboard → Founder Editor).
//
// This is the visible entry point to the Founder-only editing API in
// server/routes-founder-editor.js. It deliberately does NOT implement a second editor: it
// reuses the same proposal/approval components as the @ashai conversation, so a change has
// exactly one workflow wherever the Founder starts it.
//
// Workflow enforced here:
//   1. choose an editable item (page text, a new section, or theme),
//   2. Preview → the server stores an inert proposal and NOTHING is written,
//   3. Apply changes → an explicit approval that writes a TEST draft,
//   4. publish is a separate confirmed step, and every version can be rolled back.
//
// Authorization is enforced by the server on every call; this page is additionally guarded
// by the /founder/editor route so a non-Founder never sees it.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, Field, Spinner, useToast } from '../ui.jsx';
import EditorProposal from '../components/EditorProposal.jsx';
import FounderEditorPanel from '../components/FounderEditorPanel.jsx';
import ProposalInbox from '../components/ProposalInbox.jsx';

const MODES = [
  { id: 'text', label: 'Page heading or description' },
  { id: 'section', label: 'Add a section to a page' },
  { id: 'theme', label: 'Theme colour, font or corner radius' },
];

function when(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function FounderEditor() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState('text');
  const [page, setPage] = useState('home');
  const [field, setField] = useState('heading');
  const [value, setValue] = useState('');
  const [sectionTitle, setSectionTitle] = useState('');
  const [sectionBody, setSectionBody] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaHref, setCtaHref] = useState('');
  const [themeKey, setThemeKey] = useState('accent');
  const [themeValue, setThemeValue] = useState('#00ff88');
  const [proposal, setProposal] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api('/founder/editor/status');
      setStatus(res);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load the Founder Editor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const registry = (status && status.registry) || null;
  const pages = (registry && registry.pages) || [];
  const themeKeys = (registry && registry.theme) || [];
  const currentPage = pages.find((entry) => entry.page === page);
  const fields = (currentPage && currentPage.fields) || ['heading', 'subheading'];
  const liveVersion = status && status.live;
  const draftVersion = status && status.draft;
  const events = (status && status.events) || [];

  function describe() {
    if (mode === 'text') return `Set the ${page} page ${field} to “${value}”`;
    if (mode === 'section') return `Add a new section to the ${page} page`;
    const meta = themeKeys.find((entry) => entry.key === themeKey);
    return `Set ${meta ? meta.label : themeKey} to ${themeValue}`;
  }

  // The change objects are built here but are only ever sent to /propose: the server turns
  // them into an inert proposal, and a separate approval call writes the TEST draft.
  function buildChanges() {
    if (mode === 'text') return [{ op: 'set_text', page, field, value }];
    if (mode === 'section') {
      if (!sectionTitle.trim()) return null;
      const change = { op: 'add_section', page, title: sectionTitle.trim(), body: sectionBody.trim() };
      if (ctaLabel.trim()) change.ctaLabel = ctaLabel.trim();
      if (ctaHref.trim()) change.ctaHref = ctaHref.trim();
      return [change];
    }
    if (!themeValue.trim()) return null;
    return [{ op: 'set_theme', key: themeKey, value: themeValue.trim() }];
  }

  async function preview() {
    const changes = buildChanges();
    if (!changes) {
      setError('Fill in the fields for this edit first.');
      return;
    }
    setBusy(true);
    setError('');
    setProposal(null);
    try {
      const data = await api('/founder/editor/propose', {
        method: 'POST',
        body: { changes, summary: describe() },
      });
      setProposal(data.proposal);
      toast.push('Preview ready. Nothing is applied until you approve it.', 'info');
      await load();
    } catch (err) {
      setError(err.message || 'That preview could not be generated.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Loading Founder Editor" />;
  if (error && !status) return <div className="banner danger">{error}</div>;

  return (
    <div className="stack">
      <div className="card founder-head">
        <div>
          <div className="tiny muted">Founder only · Hassan Shuaibu Adam</div>
          <h2 style={{ margin: '4px 0' }}>Founder Editor</h2>
          <div className="muted small">
            {liveVersion ? `LIVE v${liveVersion.number}` : 'No LIVE version yet'}
            {draftVersion ? ` · TEST draft v${draftVersion.number}` : ' · no draft'}
            {' · '}every change needs your approval and can be rolled back
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn ghost sm" to="/founder">Founder Dashboard</Link>
          <button className="btn ghost sm" onClick={load} disabled={busy}>Refresh</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. Choose what to edit</h3>
        <p className="tiny muted" style={{ marginTop: -6 }}>
          Pick an existing page, section type or theme value. Preview creates a proposal — it never changes the
          application.
        </p>

        <div className="grid-2">
          <Field label="Edit type">
            <select
              className="select"
              value={mode}
              onChange={(event) => {
                setMode(event.target.value);
                setProposal(null);
              }}
            >
              {MODES.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </select>
          </Field>

          {mode !== 'theme' ? (
            <Field label="Page">
              <select
                className="select"
                value={page}
                onChange={(event) => {
                  setPage(event.target.value);
                  setField('heading');
                  setProposal(null);
                }}
              >
                {pages.map((entry) => (
                  <option key={entry.page} value={entry.page}>{entry.label}</option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>

        {mode === 'text' ? (
          <div className="grid-2">
            <Field label="Field">
              <select className="select" value={field} onChange={(event) => setField(event.target.value)}>
                {fields.map((entry) => (
                  <option key={entry} value={entry}>{entry === 'heading' ? 'Heading' : 'Description'}</option>
                ))}
              </select>
            </Field>
            <Field label="New text" hint="Leave empty to clear the heading or description.">
              <input className="input" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Your Network. Your Privacy. Your World." />
            </Field>
          </div>
        ) : null}

        {mode === 'section' ? (
          <div className="stack" style={{ gap: 8 }}>
            <Field label="Section title">
              <input className="input" value={sectionTitle} onChange={(event) => setSectionTitle(event.target.value)} placeholder="What’s new on #ash Mesh" />
            </Field>
            <Field label="Section text">
              <textarea className="textarea" rows={3} value={sectionBody} onChange={(event) => setSectionBody(event.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label="Button label (optional)">
                <input className="input" value={ctaLabel} onChange={(event) => setCtaLabel(event.target.value)} placeholder="Explore Marketplace" />
              </Field>
              <Field label="Button link (optional)">
                <input className="input" value={ctaHref} onChange={(event) => setCtaHref(event.target.value)} placeholder="/market" />
              </Field>
            </div>
          </div>
        ) : null}

        {mode === 'theme' ? (
          <div className="grid-2">
            <Field label="Theme value">
              <select className="select" value={themeKey} onChange={(event) => setThemeKey(event.target.value)}>
                {themeKeys.map((entry) => (
                  <option key={entry.key} value={entry.key}>{entry.label}</option>
                ))}
              </select>
            </Field>
            <Field label="New value" hint="A colour such as #00ff88, a font name, or a radius in pixels.">
              <input className="input" value={themeValue} onChange={(event) => setThemeValue(event.target.value)} />
            </Field>
          </div>
        ) : null}

        {error ? <div className="banner danger tiny">{error}</div> : null}

        <div className="editor-actions">
          <button className="btn primary" onClick={preview} disabled={busy}>
            {busy ? 'Building preview…' : 'Preview change'}
          </button>
          <span className="tiny muted">Preview writes nothing. You approve the change in the next step.</span>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>2. Preview and approve</h3>
        <p className="tiny muted" style={{ marginTop: -6 }}>
          The card below shows exactly what would change. “Apply changes” writes a TEST draft; nothing reaches users
          until you publish, and every version can be rolled back.
        </p>
        {proposal ? (
          <EditorProposal initial={proposal} />
        ) : (
          <Empty title="No change previewed yet" hint="Choose an edit above and press Preview change." />
        )}
        <ProposalInbox enabled excludeId={proposal && proposal.id} />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>3. Version history and rollback</h3>
        <p className="tiny muted" style={{ marginTop: -6 }}>
          Every applied change is kept as its own version, so a rollback restores the previous value without deleting
          history.
        </p>
        <FounderEditorPanel />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Editor audit trail</h3>
        {events.length === 0 ? (
          <Empty title="No editor actions yet" />
        ) : (
          <table className="table">
            <thead><tr><th>Action</th><th>Detail</th><th>When</th></tr></thead>
            <tbody>
              {events.map((row) => (
                <tr key={row.id}>
                  <td>{row.action}</td>
                  <td className="muted tiny">{typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail)}</td>
                  <td className="muted">{when(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
