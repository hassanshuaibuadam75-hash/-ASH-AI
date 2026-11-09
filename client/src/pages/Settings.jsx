import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { Field, Spinner, useToast, Badge } from '../ui.jsx';
import { readCapabilities, describeCapabilities, lowPower } from '../uar.js';

export default function Settings() {
  const { user, refresh, logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [relay, setRelay] = useState(null);
  const [caps, setCaps] = useState(null);
  const [savingRelay, setSavingRelay] = useState(false);

  useEffect(() => {
    api('/uar/relay').then((d) => setRelay(d.relay)).catch(() => setRelay({ enabled: false, allowCellular: false, maxBatteryDrain: 20 }));
    readCapabilities().then(setCaps);
  }, []);

  async function changePassword(event) {
    event.preventDefault();
    if (next !== confirm) { toast.push('The new passwords do not match.', 'error'); return; }
    setSaving(true);
    try {
      await api('/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent(''); setNext(''); setConfirm('');
      toast.push('Password updated.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function saveRelay(patch) {
    const body = { ...relay, ...patch };
    setSavingRelay(true);
    try {
      const data = await api('/uar/relay', { method: 'PUT', body });
      setRelay(data.relay);
      toast.push('Relay preference saved.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setSavingRelay(false);
    }
  }

  if (!relay) return <Spinner label="Loading settings" />;

  return (
    <div className="stack">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Account</h2>
        <div className="row wrap" style={{ gap: 24 }}>
          <div><span className="tiny muted">Username</span><div>@{user.username}</div></div>
          <div><span className="tiny muted">Email</span><div>{user.email}</div></div>
          <div><span className="tiny muted">Role</span><div><Badge tone={user.isFounder ? 'green' : 'grey'}>{user.isFounder ? 'Founder & CEO' : user.role}</Badge></div></div>
          <div><span className="tiny muted">Status</span><div>{user.status || 'active'}</div></div>
        </div>
        <div className="row" style={{ marginTop: 16, gap: 8 }}>
          <button className="btn ghost" onClick={logout}>Log out of this device</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change password</h3>
        <form onSubmit={changePassword} className="stack" style={{ maxWidth: 420 }}>
          <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required /></Field>
          <Field label="New password" hint="At least 8 characters with letters and numbers"><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required /></Field>
          <Field label="Confirm new password"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></Field>
          <button className="btn primary" disabled={saving} style={{ alignSelf: 'flex-start' }}>{saving ? <span className="spinner" /> : 'Update password'}</button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Privacy</h3>
        <p className="muted small">
          Profile, phone, email and location visibility are controlled per field on your profile edit screen.
          Private messages are encrypted on your device; the server stores only ciphertext.
        </p>
        <button className="btn ghost" onClick={async () => { await refresh(); toast.push('Settings refreshed.', 'success'); }}>Refresh account data</button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Universal Gateway (relay)</h3>
        <p className="muted small">
          Opting in lets your device pass on encrypted messages for people nearby when you have connectivity.
          Relay devices never receive decryption keys, so message content stays unreadable to you. You can revoke this at any time.
        </p>
        <div className="stack" style={{ maxWidth: 460 }}>
          <label className="row" style={{ gap: 10 }}>
            <input
              type="checkbox"
              checked={!!relay.enabled}
              disabled={savingRelay}
              onChange={(e) => saveRelay({ enabled: e.target.checked })}
            />
            <span>Allow this device to relay encrypted traffic</span>
          </label>
          <label className="row" style={{ gap: 10 }}>
            <input
              type="checkbox"
              checked={!!relay.allowCellular}
              disabled={savingRelay || !relay.enabled}
              onChange={(e) => saveRelay({ allowCellular: e.target.checked })}
            />
            <span>Allow relaying over mobile data (uses your data plan)</span>
          </label>
          <Field label={`Stop relaying below ${relay.maxBatteryDrain}% battery`}>
            <input
              type="range" min="5" max="60" step="5" value={relay.maxBatteryDrain}
              disabled={savingRelay || !relay.enabled}
              onChange={(e) => setRelay({ ...relay, maxBatteryDrain: Number(e.target.value) })}
              onMouseUp={(e) => saveRelay({ maxBatteryDrain: Number(e.target.value) })}
              onTouchEnd={(e) => saveRelay({ maxBatteryDrain: Number(e.target.value) })}
            />
          </Field>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>This device</h3>
        {caps ? (
          <ul className="plain-list">
            {describeCapabilities(caps).map((line) => <li key={line}>{line}</li>)}
            {lowPower(caps.battery) ? <li className="warn-text">Battery below 20% — power-intensive networking is reduced.</li> : null}
          </ul>
        ) : <Spinner label="Reading device capabilities" />}
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Offline radio routing (Wi-Fi Aware, Wi-Fi Direct, Bluetooth LE, LoRa) requires the #ash Mesh Android app with its native plugin.
          A web page cannot use those radios, so the web build routes over the internet and queues messages while offline.
        </p>
      </div>
    </div>
  );
}
