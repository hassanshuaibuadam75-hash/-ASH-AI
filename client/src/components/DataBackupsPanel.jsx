// #ash Mesh — Founder-only Data & Backups panel.
//
// Every control here calls a real endpoint guarded by requireFounder on the server; nothing
// in this component decides authorization. The panel exists because the Free plan has no
// persistent disk: snapshots inside the container disappear on redeploy, so the Founder has
// to be able to download an archive and restore it later.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatTime } from '../api.js';
import { Empty, Spinner, useToast } from '../ui.jsx';

const REASON_LABEL = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  'pre-restore': 'Safety (before restore)',
  'pre-archive-restore': 'Safety (before archive restore)',
  'pre-export': 'Before export',
};

const mb = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(2)} MB`;

async function saveFile(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function DataBackupsPanel() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState('');
  const fileRef = useRef(null);
  const archiveRef = useRef(null);
  const [archivePending, setArchivePending] = useState(null);

  const load = useCallback(async () => {
    try {
      setState(await api('/founder/backups'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy('create');
    try {
      const { backup } = await api('/founder/backups', { method: 'POST' });
      toast.push(`Snapshot created · ${mb(backup?.sizeBytes)}`, 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function verify(name) {
    setBusy(`verify:${name}`);
    try {
      const { verification } = await api(`/founder/backups/${encodeURIComponent(name)}/verify`, { method: 'POST' });
      const ok = verification?.integrity === 'ok' && verification?.checksumMatches !== false;
      toast.push(ok ? 'Snapshot verified against its recorded checksum.' : 'That snapshot did not verify.', ok ? 'success' : 'error');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function download(name) {
    setBusy(`download:${name}`);
    try {
      await saveFile(`/founder/backups/${encodeURIComponent(name)}/download`, name);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function downloadArchive() {
    setBusy('export');
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      await saveFile('/founder/export', `ash-mesh-export-${stamp}.zip`);
      toast.push('Archive downloaded. Keep it outside the hosting container.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function restore(name) {
    setBusy(`restore:${name}`);
    setPending('');
    try {
      await api(`/founder/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: { confirm: true } });
      toast.push('Snapshot restored. Accounts, posts and messages are back.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function uploadRestore(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('upload');
    try {
      const form = new FormData();
      form.append('file', file);
      await api('/founder/backups/restore-upload', { method: 'POST', form });
      toast.push('Database restored from the uploaded file.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  // Restoring an export archive brings back the database rows AND the uploaded photos, videos
  // and files. The server validates and stages everything before it changes a single live byte.
  async function uploadArchive(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('archive');
    try {
      const form = new FormData();
      form.append('file', file);
      const { restore } = await api('/founder/export/restore', { method: 'POST', form });
      const media = restore?.media?.restored ?? 0;
      setArchivePending({
        file: file.name,
        rows: restore?.rows ?? 0,
        media,
        integrity: restore?.archive?.integrity || restore?.integrity || 'unknown',
        safetyBackup: restore?.archiveSafetyBackup || restore?.safetyBackup || null,
      });
      toast.push(`Archive restored · ${restore?.rows ?? 0} rows · ${media} media files`, 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  if (error && !state) return <div className="banner warn">{error}</div>;
  if (!state) return <Spinner label="Loading backups" />;

  const policy = state.policy || {};
  const backups = state.backups || [];
  const warnings = state.warnings || [];

  return (
    <div className="card">
      <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Data &amp; Backups</h3>
          <p className="tiny muted" style={{ margin: '4px 0 0' }}>
            {state.count} snapshot{state.count === 1 ? '' : 's'} · retention {policy.retention} · every{' '}
            {policy.intervalMinutes} min {policy.schedulerEnabled ? '(scheduler on)' : '(scheduler off)'} · uploads{' '}
            {mb(state.uploadsBytes)}
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm" onClick={create} disabled={busy === 'create'}>
            {busy === 'create' ? 'Creating…' : 'Create snapshot'}
          </button>
          <button className="btn ghost sm" onClick={downloadArchive} disabled={busy === 'export'}>
            {busy === 'export' ? 'Packing…' : 'Download archive (.zip)'}
          </button>
          <button className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={busy === 'upload'}>
            {busy === 'upload' ? 'Restoring…' : 'Restore from file'}
          </button>
          <button className="btn ghost sm" onClick={() => archiveRef.current?.click()} disabled={busy === 'archive'}>
            {busy === 'archive' ? 'Restoring…' : 'Restore from archive (.zip)'}
          </button>
          <input ref={fileRef} type="file" accept=".db,.sqlite,.sqlite3" hidden onChange={uploadRestore} />
          <input ref={archiveRef} type="file" accept=".zip,application/zip" hidden onChange={uploadArchive} data-testid="archive-restore-input" />
        </div>
      </div>

      {archivePending ? (
        <div className="banner" style={{ marginTop: 12 }}>
          <div className="small">
            Archive <code>{archivePending.file}</code> restored: {archivePending.rows} rows and {archivePending.media}{' '}
            media file{archivePending.media === 1 ? '' : 's'} · integrity {archivePending.integrity}
            {archivePending.safetyBackup ? ` · safety snapshot ${archivePending.safetyBackup}` : ''}
          </div>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {warnings.map((line) => (
            <div key={line} className="small">{line}</div>
          ))}
        </div>
      ) : null}

      <p className="tiny muted">
        Snapshots live in <code>{policy.directory}</code> inside the container
        {policy.durableStorage ? '' : ' and are not durable on this plan'} · archive includes uploaded files:{' '}
        {policy.includesUploadsInArchive ? 'yes' : 'no'} · archive restore writes media back:{' '}
        {policy.archiveRestoreIncludesUploads ? 'yes' : 'no'} · newest{' '}
        {state.latest ? `${formatTime(state.latest.createdAt)} ago (${mb(state.latest.sizeBytes)})` : '—'}
      </p>

      {backups.length === 0 ? (
        <Empty title="No snapshot yet" hint="Create one now, or download an archive before your next deploy." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Snapshot</th>
              <th>Reason</th>
              <th>Size</th>
              <th>Rows</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((row) => (
              <React.Fragment key={row.name}>
                <tr>
                  <td className="tiny">
                    {row.name}
                    <div className="tiny muted">
                      integrity: {row.integrity || 'unknown'} · {row.tableCount ?? '—'} tables
                    </div>
                  </td>
                  <td>{REASON_LABEL[row.reason] || row.reason}</td>
                  <td>{mb(row.sizeBytes)}</td>
                  <td>{row.rows ?? '—'}</td>
                  <td className="muted">{formatTime(row.createdAt)}</td>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <button className="btn ghost sm" onClick={() => verify(row.name)} disabled={!!busy}>
                        {busy === `verify:${row.name}` ? 'Verifying…' : 'Verify'}
                      </button>
                      <button className="btn ghost sm" onClick={() => download(row.name)} disabled={!!busy}>
                        {busy === `download:${row.name}` ? 'Downloading…' : 'Download'}
                      </button>
                      <button className="btn sm" onClick={() => setPending(row.name)} disabled={!!busy}>
                        Restore
                      </button>
                    </div>
                  </td>
                </tr>
                {pending === row.name ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="banner warn">
                        <div className="small" style={{ marginBottom: 8 }}>
                          Restoring replaces the live database with this snapshot. A safety snapshot is taken first, and
                          the restore rolls back if anything fails. Records created after this snapshot are removed.
                        </div>
                        <div className="row wrap" style={{ gap: 8 }}>
                          <button className="btn sm" onClick={() => restore(row.name)} disabled={busy === `restore:${row.name}`}>
                            {busy === `restore:${row.name}` ? 'Restoring…' : 'Yes, restore this snapshot'}
                          </button>
                          <button className="btn ghost sm" onClick={() => setPending('')} disabled={!!busy}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
