import React, { useCallback, useEffect, useState } from 'react';
import { api, formatTime, naira } from '../api.js';
import { useAuth } from '../App.jsx';
import { Badge, Empty, Field, Modal, Spinner, useToast } from '../ui.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['users', 'Users'],
  ['reports', 'Reports'],
  ['verifications', 'Verifications'],
  ['audit', 'Audit log'],
];

export default function Admin() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [users, setUsers] = useState(null);
  const [reports, setReports] = useState(null);
  const [verifications, setVerifications] = useState(null);
  const [audit, setAudit] = useState(null);
  const [query, setQuery] = useState('');
  const [reportStatus, setReportStatus] = useState('open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusDialog, setStatusDialog] = useState(null);
  const [statusReason, setStatusReason] = useState('');
  const [roleDialog, setRoleDialog] = useState(null);
  const [roleForm, setRoleForm] = useState({ role: 'moderator', permissions: [] });
  const [resolveDialog, setResolveDialog] = useState(null);
  const [resolveForm, setResolveForm] = useState({ action: 'resolve', status: 'resolved', note: '' });

  const granted = overview?.permissions || [];
  const isFounder = overview?.isFounder;
  const can = (key) => isFounder || granted.includes('*') || granted.includes(key);

  const loadOverview = useCallback(async () => {
    try {
      const data = await api('/admin/overview');
      setOverview(data.overview);
      setPermissions(data.availablePermissions);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api(`/admin/users?q=${encodeURIComponent(query)}`);
      setUsers(data.users);
    } catch (err) {
      toast.push(err.message, 'error');
      setUsers([]);
    }
  }, [query, toast]);

  const loadReports = useCallback(async () => {
    try {
      const data = await api(`/admin/reports?status=${reportStatus}`);
      setReports(data.reports);
    } catch (err) {
      toast.push(err.message, 'error');
      setReports([]);
    }
  }, [reportStatus, toast]);

  const loadVerifications = useCallback(async () => {
    try {
      const data = await api('/admin/verifications?status=pending');
      setVerifications(data.verifications);
    } catch (err) {
      toast.push(err.message, 'error');
      setVerifications([]);
    }
  }, [toast]);

  const loadAudit = useCallback(async () => {
    try {
      const data = await api('/admin/audit?limit=100');
      setAudit(data.entries);
    } catch (err) {
      toast.push(err.message, 'error');
      setAudit([]);
    }
  }, [toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { if (tab === 'users') loadUsers(); }, [tab, loadUsers]);
  useEffect(() => { if (tab === 'reports') loadReports(); }, [tab, loadReports]);
  useEffect(() => { if (tab === 'verifications') loadVerifications(); }, [tab, loadVerifications]);
  useEffect(() => { if (tab === 'audit') loadAudit(); }, [tab, loadAudit]);

  async function setAccountStatus() {
    if (!statusReason.trim()) { toast.push('A reason is required for the audit trail.', 'error'); return; }
    setBusy(true);
    try {
      await api(`/admin/users/${statusDialog.id}/status`, { method: 'POST', body: { status: statusDialog.next, reason: statusReason } });
      toast.push('Account status updated.', 'success');
      setStatusDialog(null);
      setStatusReason('');
      await loadUsers();
      await loadOverview();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveRole() {
    setBusy(true);
    try {
      await api(`/admin/users/${roleDialog.id}/role`, {
        method: 'POST',
        body: { role: roleForm.role, permissions: roleForm.role === 'member' ? [] : roleForm.permissions },
      });
      toast.push('Role and permissions updated.', 'success');
      setRoleDialog(null);
      await loadUsers();
      await refresh();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resolveReport() {
    if (!resolveForm.note.trim()) { toast.push('A resolution note is required.', 'error'); return; }
    setBusy(true);
    try {
      await api(`/admin/reports/${resolveDialog.id}/resolve`, { method: 'POST', body: resolveForm });
      toast.push('Report updated.', 'success');
      setResolveDialog(null);
      setResolveForm({ action: 'resolve', status: 'resolved', note: '' });
      await loadReports();
      await loadOverview();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reviewVerification(row, decision) {
    setBusy(true);
    try {
      await api(`/admin/verifications/${row.id}/review`, { method: 'POST', body: { decision, note: decision === 'approve' ? 'Identity document reviewed.' : 'Document did not meet requirements.' } });
      toast.push(decision === 'approve' ? 'Seller approved.' : 'Verification rejected.', 'success');
      await loadVerifications();
      await loadOverview();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="banner warn">{error}</div>;
  if (!overview) return <Spinner label="Loading administration" />;

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Administration</h2>
          <div className="row" style={{ gap: 6 }}>
            <Badge tone={isFounder ? 'green' : 'grey'}>{isFounder ? 'Founder' : overview.role}</Badge>
            <span className="tiny muted">{granted.length} permission{granted.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="tabs" style={{ marginTop: 12 }}>
          {TABS.filter(([key]) => (
            key === 'overview' || key === 'users' ? can('users.view') || can('moderation.users')
              : key === 'reports' ? can('moderation.reports')
                : key === 'verifications' ? can('verification.review')
                  : can('audit.view')
          )).map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      </div>

      {tab === 'overview' ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Your administrative scope</h3>
          {isFounder ? (
            <p className="muted small">
              You hold Founder authority: full access to every administrative area. Founder authority cannot be granted to
              another account, and other administrators cannot act on your account.
            </p>
          ) : (
            <p className="muted small">
              Your access is limited to the permissions the Founder assigned to you. You cannot grant permissions,
              change roles, or act on administrators.
            </p>
          )}
          <ul className="plain-list">
            {permissions.filter((p) => can(p.key)).map((p) => <li key={p.key}><strong>{p.label}</strong> <span className="tiny muted">{p.key}</span></li>)}
          </ul>
          <div className="stat-grid" style={{ marginTop: 12 }}>
            {overview.users ? <div className="stat"><div className="stat-label">Users</div><div className="stat-value">{overview.users.total}</div><div className="tiny muted">{overview.users.activeToday} active today · {overview.users.restricted} restricted · {overview.users.suspended} suspended</div></div> : null}
            {overview.reports ? <div className="stat"><div className="stat-label">Reports</div><div className="stat-value">{overview.reports.open}</div><div className="tiny muted">{overview.reports.reviewing} reviewing · {overview.reports.resolved} resolved</div></div> : null}
            {overview.verifications ? <div className="stat"><div className="stat-label">Verifications</div><div className="stat-value">{overview.verifications.pending}</div><div className="tiny muted">awaiting review</div></div> : null}
            {overview.marketplace ? <div className="stat"><div className="stat-label">Marketplace</div><div className="stat-value">{overview.marketplace.orders}</div><div className="tiny muted">{overview.marketplace.activeListings} active listings · {naira(overview.marketplace.commissionMinor)} commission</div></div> : null}
          </div>
        </div>
      ) : null}

      {tab === 'users' ? (
        <div className="card">
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            <input placeholder="Search users" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Search users" />
            <button className="btn ghost sm" onClick={loadUsers}>Search</button>
          </div>
          {!users ? <Spinner label="Loading users" /> : null}
          {users?.length === 0 ? <Empty title="No users found" /> : null}
          {users?.length ? (
            <table className="table">
              <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.fullName || row.username}</div>
                      <div className="tiny muted">@{row.username} · {row.email}</div>
                    </td>
                    <td><Badge tone={row.isFounder ? 'green' : row.role === 'admin' ? 'amber' : 'grey'}>{row.isFounder ? 'Founder' : row.role}</Badge></td>
                    <td><Badge tone={row.status === 'active' ? 'green' : row.status === 'restricted' ? 'amber' : 'red'}>{row.status}</Badge></td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {!row.isFounder && can('moderation.users') ? (
                          row.status === 'active'
                            ? <button className="btn ghost sm" onClick={() => { setStatusDialog({ ...row, next: 'restricted' }); setStatusReason(''); }}>Restrict</button>
                            : <button className="btn ghost sm" onClick={() => { setStatusDialog({ ...row, next: 'active' }); setStatusReason(''); }}>Restore</button>
                        ) : null}
                        {!row.isFounder && row.status !== 'suspended' && can('moderation.users') ? (
                          <button className="btn ghost sm danger-text" onClick={() => { setStatusDialog({ ...row, next: 'suspended' }); setStatusReason(''); }}>Suspend</button>
                        ) : null}
                        {isFounder && !row.isFounder ? (
                          <button
                            className="btn ghost sm"
                            onClick={() => {
                              setRoleForm({ role: row.role === 'member' ? 'moderator' : row.role, permissions: row.permissions || [] });
                              setRoleDialog(row);
                            }}
                          >
                            Role
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {tab === 'reports' ? (
        <div className="card">
          <div className="tabs" style={{ marginBottom: 12 }}>
            {['open', 'reviewing', 'resolved', 'dismissed'].map((status) => (
              <button key={status} className={`tab ${reportStatus === status ? 'active' : ''}`} onClick={() => setReportStatus(status)}>{status}</button>
            ))}
          </div>
          {!reports ? <Spinner label="Loading reports" /> : null}
          {reports?.length === 0 ? <Empty title="Nothing here" hint="No reports with this status." /> : null}
          {reports?.map((report) => (
            <div className="order-row" key={report.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{report.reason.replace(/_/g, ' ')} · {report.targetType}</div>
                <div className="tiny muted">
                  reported by @{report.reporter?.username} · {formatTime(report.createdAt)} · target {report.targetId.slice(0, 8)}
                </div>
                {report.details ? <div className="small" style={{ marginTop: 4 }}>{report.details}</div> : null}
                {report.resolutionNote ? <div className="tiny muted">Note: {report.resolutionNote}</div> : null}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Badge tone={report.status === 'resolved' ? 'green' : report.status === 'open' ? 'amber' : 'grey'}>{report.status}</Badge>
                {report.status !== 'resolved' && report.status !== 'dismissed' ? (
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      setResolveForm({ action: 'resolve', status: 'resolved', note: '' });
                      setResolveDialog(report);
                    }}
                  >
                    Review
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'verifications' ? (
        <div className="card">
          {!verifications ? <Spinner label="Loading verifications" /> : null}
          {verifications?.length === 0 ? <Empty title="No pending verifications" /> : null}
          {verifications?.map((row) => (
            <div className="order-row" key={row.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{row.businessName || row.fullName || row.username}</div>
                <div className="tiny muted">@{row.username} · {row.idType} · {row.idNumber} · {formatTime(row.createdAt)}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {row.documentUrl ? <a className="btn ghost sm" href={row.documentUrl} target="_blank" rel="noreferrer">Document</a> : null}
                <button className="btn sm" disabled={busy} onClick={() => reviewVerification(row, 'approve')}>Approve</button>
                <button className="btn ghost sm danger-text" disabled={busy} onClick={() => reviewVerification(row, 'reject')}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'audit' ? (
        <div className="card">
          {!audit ? <Spinner label="Loading audit log" /> : null}
          {audit?.length === 0 ? <Empty title="No audit entries yet" /> : null}
          {audit?.length ? (
            <table className="table">
              <thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>IP</th><th>When</th></tr></thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.action}</td>
                    <td>{entry.actor ? `@${entry.actor.username}` : 'system'}</td>
                    <td className="muted">{entry.targetType || '—'}</td>
                    <td className="muted">{entry.ip || '—'}</td>
                    <td className="muted">{formatTime(entry.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {statusDialog ? (
        <Modal
          title={`${statusDialog.next === 'active' ? 'Restore' : statusDialog.next === 'restricted' ? 'Restrict' : 'Suspend'} @${statusDialog.username}`}
          onClose={() => setStatusDialog(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setStatusDialog(null)}>Cancel</button>
              <button className={`btn ${statusDialog.next === 'active' ? 'primary' : 'danger'}`} disabled={busy} onClick={setAccountStatus}>Confirm</button>
            </>
          }
        >
          <p className="muted small">
            {statusDialog.next === 'active'
              ? 'The account regains normal access.'
              : statusDialog.next === 'restricted'
                ? 'The account can sign in but is limited by moderation policy.'
                : 'The account is suspended and all its sessions are revoked.'}
          </p>
          <Field label="Reason (recorded in the audit log)">
            <textarea rows={3} value={statusReason} onChange={(e) => setStatusReason(e.target.value)} maxLength={300} />
          </Field>
        </Modal>
      ) : null}

      {roleDialog ? (
        <Modal
          title={`Role for @${roleDialog.username}`}
          onClose={() => setRoleDialog(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setRoleDialog(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={saveRole}>Save</button>
            </>
          }
        >
          <p className="tiny muted">Only the Founder can assign roles. Founder authority itself can never be transferred.</p>
          <Field label="Role">
            <select value={roleForm.role} onChange={(e) => setRoleForm({ ...roleForm, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="moderator">Moderator</option>
              <option value="admin">Administrator</option>
            </select>
          </Field>
          {roleForm.role !== 'member' ? (
            <div style={{ marginTop: 10 }}>
              <div className="tiny muted" style={{ marginBottom: 6 }}>Explicit permissions</div>
              {permissions.map((p) => (
                <label key={p.key} className="check-row">
                  <input
                    type="checkbox"
                    checked={roleForm.permissions.includes(p.key)}
                    onChange={(e) => setRoleForm({
                      ...roleForm,
                      permissions: e.target.checked
                        ? [...roleForm.permissions, p.key]
                        : roleForm.permissions.filter((k) => k !== p.key),
                    })}
                  />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {resolveDialog ? (
        <Modal
          title="Review report"
          onClose={() => setResolveDialog(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setResolveDialog(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={resolveReport}>Apply</button>
            </>
          }
        >
          <Field label="Action">
            <select value={resolveForm.action} onChange={(e) => setResolveForm({ ...resolveForm, action: e.target.value })}>
              <option value="resolve">Record decision only</option>
              <option value="remove_content">Remove reported content</option>
              <option value="restrict_user">Restrict the account</option>
              <option value="suspend_user">Suspend the account</option>
            </select>
          </Field>
          <Field label="Outcome">
            <select value={resolveForm.status} onChange={(e) => setResolveForm({ ...resolveForm, status: e.target.value })}>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
              <option value="reviewing">Keep under review</option>
            </select>
          </Field>
          <Field label="Resolution note (audit trail)">
            <textarea rows={3} value={resolveForm.note} onChange={(e) => setResolveForm({ ...resolveForm, note: e.target.value })} maxLength={500} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
