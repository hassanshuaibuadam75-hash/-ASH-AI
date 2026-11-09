// #ash Mesh — #ash Heritage (online + offline).
//
// Members record culture, language, craft and history. Published entries are cached in
// the local database so they can still be read — and respected — without a connection.
import React, { useCallback, useEffect, useState } from 'react';
import { api, formatTime } from '../api.js';
import { Avatar, Badge, ConfirmDialog, Empty, Field, Modal, Spinner, useToast } from '../ui.jsx';
import { useAuth } from '../App.jsx';
import { cacheHeritage, readHeritage } from '../localdb.js';

const CATEGORIES = ['story', 'language', 'craft', 'music', 'history', 'recipe'];
const REACTIONS = [
  { kind: 'respect', label: 'Respect' },
  { kind: 'love', label: 'Love' },
  { kind: 'insightful', label: 'Insightful' },
];

export default function Heritage() {
  const { user } = useAuth();
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    try {
      const data = await api(`/heritage?${params.toString()}`);
      setEntries(data.entries || []);
      setOffline(false);
      if (!query && !category) await cacheHeritage(data.entries || []);
    } catch {
      const cached = await readHeritage();
      const filtered = cached.filter((entry) => {
        const matchesQuery =
          !query ||
          [entry.title, entry.body, entry.region, entry.language]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query.toLowerCase()));
        const matchesCategory = !category || entry.category === category;
        return matchesQuery && matchesCategory;
      });
      setEntries(filtered);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [query, category]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <h2 className="h2">#ash Heritage</h2>
            <p className="muted small">Preserve the stories, languages and knowledge around you.</p>
          </div>
          <button className="btn primary" onClick={() => setCreating(true)} disabled={offline}>+ Add entry</button>
        </div>

        <div className="row gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <input className="input" placeholder="Search heritage" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {offline && (
          <p className="small" style={{ marginTop: 10, color: 'var(--ash-amber, #ffc857)' }}>
            Saved offline — showing heritage entries stored on this device.
          </p>
        )}
      </div>

      {loading ? (
        <Spinner label="Loading heritage" />
      ) : entries.length === 0 ? (
        <Empty title="Nothing recorded yet" hint={offline ? 'Entries you open online are kept for offline reading.' : 'Add the first entry.'} />
      ) : (
        entries.map((entry) => (
          <button key={entry.id} className="card" style={{ textAlign: 'left' }} onClick={() => setOpen(entry.id)}>
            <div className="row between">
              <strong>{entry.title}</strong>
              <Badge tone="green">{entry.category}</Badge>
            </div>
            <p className="muted small" style={{ margin: '6px 0' }}>
              {String(entry.body || '').slice(0, 140)}{String(entry.body || '').length > 140 ? '…' : ''}
            </p>
            <div className="row gap small muted">
              {entry.region && <span>{entry.region}</span>}
              {entry.language && <span>· {entry.language}</span>}
              <span>· {formatTime(entry.createdAt)}</span>
            </div>
          </button>
        ))
      )}

      {creating && (
        <CreateEntry
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
          toast={toast}
        />
      )}
      {open && (
        <EntryDetail
          id={open}
          me={user}
          offline={offline}
          onClose={() => setOpen(null)}
          onChanged={load}
          toast={toast}
        />
      )}
    </div>
  );
}

function CreateEntry({ onClose, onCreated, toast }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('story');
  const [region, setRegion] = useState('');
  const [language, setLanguage] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (title.trim().length < 3) return toast.push('Give this entry a title of at least 3 characters.', 'error');
    if (!body.trim()) return toast.push('Write the story or knowledge you are preserving.', 'error');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('title', title.trim());
      form.append('body', body.trim());
      form.append('category', category);
      if (region.trim()) form.append('region', region.trim());
      if (language.trim()) form.append('language', language.trim());
      if (file) form.append('file', file);
      await api('/heritage', { method: 'POST', form });
      toast.push('Heritage entry saved');
      onCreated();
    } catch (err) {
      toast.push(err.message || 'Could not save the entry', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New heritage entry"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save entry'}</button>
        </>
      }
    >
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The story of our market" />
      </Field>
      <Field label="Entry">
        <textarea className="input" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Field label="Category">
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Region">
        <input className="input" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Kano" />
      </Field>
      <Field label="Language">
        <input className="input" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Hausa" />
      </Field>
      <Field label="Photo (optional)">
        <input className="input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </Field>
    </Modal>
  );
}

function EntryDetail({ id, me, offline, onClose, onChanged, toast }) {
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api(`/heritage/${id}`);
        if (!cancelled) setEntry(data.entry);
      } catch {
        const cached = await readHeritage();
        if (!cancelled) setEntry(cached.find((e) => e.id === id) || null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  async function react(kind) {
    try {
      const data = await api(`/heritage/${id}/react`, { method: 'POST', body: { kind } });
      setEntry(data.entry);
      onChanged?.();
    } catch (err) {
      toast.push(err.message || 'Could not record that reaction', 'error');
    }
  }

  async function remove() {
    try {
      await api(`/heritage/${id}?confirm=1`, { method: 'DELETE' });
      toast.push('Entry deleted');
      onChanged?.();
      onClose();
    } catch (err) {
      toast.push(err.message || 'Could not delete the entry', 'error');
    }
  }

  return (
    <Modal
      title={entry?.title || 'Heritage entry'}
      onClose={onClose}
      actions={
        <>
          {entry?.isOwner && <button className="btn danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      {loading ? (
        <Spinner label="Loading entry" />
      ) : !entry ? (
        <Empty title="Entry unavailable" hint="This entry is not stored on this device." />
      ) : (
        <>
          <div className="row gap" style={{ alignItems: 'center' }}>
            <Avatar user={entry.author} size={32} />
            <div>
              <strong>{entry.author?.fullName || entry.author?.username}</strong>
              <div className="muted small">
                {[entry.region, entry.language, formatTime(entry.createdAt)].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>

          {entry.mediaUrl && (
            <img src={entry.mediaUrl} alt="" style={{ width: '100%', borderRadius: 12, marginTop: 12 }} />
          )}

          <p style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{entry.body}</p>

          <div className="row gap" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            {REACTIONS.map((r) => {
              const mine = entry.myReactions?.includes(r.kind);
              const count = entry.reactions?.[r.kind] || 0;
              return (
                <button
                  key={r.kind}
                  className={`btn small ${mine ? 'primary' : ''}`}
                  onClick={() => react(r.kind)}
                  disabled={offline}
                >
                  {r.label}{count ? ` · ${count}` : ''}
                </button>
              );
            })}
          </div>

          {confirmDelete && (
            <ConfirmDialog
              title="Delete this entry?"
              message="This heritage entry will be removed for everyone."
              confirmLabel="Delete entry"
              onCancel={() => setConfirmDelete(false)}
              onConfirm={remove}
            />
          )}
        </>
      )}
    </Modal>
  );
}
