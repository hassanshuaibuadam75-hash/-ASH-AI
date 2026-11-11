import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatTime, naira } from '../api.js';
import { Badge, Empty, Field, Spinner, useToast } from '../ui.jsx';
import DataBackupsPanel from '../components/DataBackupsPanel.jsx';

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="tiny muted">{hint}</div> : null}
    </div>
  );
}

function Section({ title, children, note }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {note ? <p className="tiny muted" style={{ marginTop: -6 }}>{note}</p> : null}
      <div className="stat-grid">{children}</div>
    </div>
  );
}

const TRANSPORT_LABEL = {
  internet: 'Internet',
  nearby: '#ash Nearby',
  wifi_aware: 'Wi-Fi Aware',
  wifi_direct: 'Wi-Fi Direct',
  ble: 'Bluetooth LE',
  lora: 'LoRa gateway',
  queued: 'Offline queue',
};

export default function Founder() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('/founder/dashboard'));
      setError('');
    } catch (err) {
      setError(err.message);
      toast.push(err.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !data) return <div className="banner warn">{error}</div>;
  if (!data) return <Spinner label="Loading Founder Dashboard" />;

  const transports = Object.entries(data.networking?.transports || {});

  return (
    <div className="stack">
      <div className="card founder-head">
        <div>
          <div className="tiny muted">Exclusive access</div>
          <h2 style={{ margin: '4px 0' }}>Founder Dashboard</h2>
          <div className="muted small">
            {data.founder?.name} · {data.founder?.title} · updated {formatTime(data.generatedAt)}
          </div>
        </div>
        <button className="btn ghost sm" onClick={load}>Refresh</button>
      </div>

      {/* Stage C: the Founder Editor must be findable from the dashboard itself. */}
      <div className="card" style={{ borderColor: 'var(--line-bright)' }}>
        <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 240 }}>
            <div className="tiny muted">Founder only</div>
            <h3 style={{ margin: '4px 0' }}>Founder Editor</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Edit page headings, descriptions, sections and theme values. Every change is previewed, needs your
              explicit approval, is recorded in the audit log, and can be rolled back.
            </p>
          </div>
          <Link className="btn primary" to="/founder/editor">Open Founder Editor</Link>
        </div>
      </div>

      <Section title="People">
        <Stat label="Registered users" value={data.people.totalUsers} hint={`${data.people.newToday} joined today`} />
        <Stat label="Active (24h)" value={data.people.active24h} hint={`${data.people.newThisWeek} joined this week`} />
        <Stat label="Verified sellers" value={data.people.verifiedSellers} />
        <Stat label="Administrators" value={data.people.admins} hint="Founder authority is never delegated" />
        <Stat label="Restricted" value={data.people.restricted} />
        <Stat label="Suspended" value={data.people.suspended} />
      </Section>

      <Section title="Content">
        <Stat label="Posts" value={data.content.posts} hint={`${data.content.posts24h} in the last 24h`} />
        <Stat label="Comments" value={data.content.comments} />
        <Stat label="Likes" value={data.content.likes} />
        <Stat label="3D models" value={data.content.models3d} />
      </Section>

      <Section title="Messaging" note={data.messaging.encryption}>
        <Stat label="Conversations" value={data.messaging.conversations} />
        <Stat label="Messages" value={data.messaging.messages} hint={`${data.messaging.messages24h} in the last 24h`} />
        <Stat label="Sent via Internet" value={data.messaging.viaInternet} />
        <Stat label="Sent via #ash Nearby" value={data.messaging.viaNearby} />
        <Stat label="Queued offline" value={data.messaging.queued} />
      </Section>

      <Section title="Marketplace">
        <Stat label="Active listings" value={data.marketplace.activeListings} />
        <Stat label="Orders" value={data.marketplace.orders} hint={`${data.marketplace.paidOrders} paid or fulfilled`} />
        <Stat label="Transaction value" value={naira(data.marketplace.gmvMinor)} />
        <Stat label="Commission earned" value={naira(data.marketplace.commissionMinor)} />
        <Stat label="Transactions" value={data.marketplace.transactions} />
        <Stat label="Pending verifications" value={data.marketplace.pendingVerifications} />
      </Section>

      <Section title="Moderation">
        <Stat label="Open reports" value={data.moderation.openReports} />
        <Stat label="Under review" value={data.moderation.reviewingReports} />
        <Stat label="Resolved" value={data.moderation.resolvedReports} />
        <Stat label="Dismissed" value={data.moderation.dismissedReports} />
      </Section>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Networking activity</h3>
        <p className="tiny muted" style={{ marginTop: -6 }}>
          Reported by devices that chose each route automatically. Web clients can only report internet and queue routes.
        </p>
        {transports.length === 0 ? (
          <Empty title="No routing telemetry yet" hint="Activity appears as devices report the route they used." />
        ) : (
          <table className="table">
            <thead><tr><th>Route</th><th>Total</th><th>Last 24h</th><th>Last activity</th></tr></thead>
            <tbody>
              {transports.map(([key, value]) => (
                <tr key={key}>
                  <td>{TRANSPORT_LABEL[key] || key}</td>
                  <td>{value.total}</td>
                  <td>{value.last24h}</td>
                  <td className="muted">{value.lastAt ? formatTime(value.lastAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row wrap" style={{ gap: 16, marginTop: 12 }}>
          <div><span className="tiny muted">Relay devices opted in</span><div style={{ fontWeight: 700 }}>{data.networking.relayDevices}</div></div>
          <div><span className="tiny muted">Active internet sessions</span><div style={{ fontWeight: 700 }}>{data.networking.internetConnectivity.activeSessions}</div></div>
          <div><span className="tiny muted">Last internet sync</span><div style={{ fontWeight: 700 }}>{data.networking.internetConnectivity.lastInternetTelemetry ? formatTime(data.networking.internetConnectivity.lastInternetTelemetry) : '—'}</div></div>
          <div><span className="tiny muted">Last nearby sync</span><div style={{ fontWeight: 700 }}>{data.networking.internetConnectivity.lastNearbyTelemetry ? formatTime(data.networking.internetConnectivity.lastNearbyTelemetry) : '—'}</div></div>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Wi-Fi Aware, Wi-Fi Direct, Bluetooth LE and LoRa appear here only when a native device actually reports that route.
          The web build cannot open those radios, and this dashboard does not invent their numbers.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>System health</h3>
        <div className="stat-grid">
          <Stat label="Uptime" value={`${Math.floor(data.system.uptimeSeconds / 3600)}h ${Math.floor((data.system.uptimeSeconds % 3600) / 60)}m`} />
          <Stat label="Memory (RSS)" value={`${data.system.memoryMb} MB`} />
          <Stat label="Database size" value={`${data.system.dbSizeMb} MB`} />
          <Stat label="Runtime" value={data.system.nodeVersion} hint={data.system.environment} />
          <Stat label="Storage backend" value={data.system.storageBackend} />
          <Stat label="Payments" value={data.system.paymentsConfigured ? 'Configured' : 'Not configured'} />
          <Stat label="#ash AI" value={data.system.aiConfigured ? 'Configured' : 'Not configured'} />
          <Stat label="Email" value={data.system.emailConfigured ? 'Configured' : 'Not configured'} />
        </div>
      </div>

      <DataBackupsPanel />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent administrative activity</h3>
        {data.recentAudit.length === 0 ? (
          <Empty title="No administrative actions yet" />
        ) : (
          <table className="table">
            <thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>When</th></tr></thead>
            <tbody>
              {data.recentAudit.map((row, i) => (
                <tr key={`${row.created_at}-${i}`}>
                  <td>{row.action}</td>
                  <td>{row.username ? `@${row.username}` : 'system'}</td>
                  <td className="muted">{row.target_type || '—'}</td>
                  <td className="muted">{formatTime(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
