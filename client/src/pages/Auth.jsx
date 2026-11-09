import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { Field, useToast } from '../ui.jsx';

export default function AuthPage() {
  const { setUser } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', username: '', fullName: '', password: '', identifier: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (window.location.pathname.startsWith('/reset-password')) {
      setMode('reset');
      if (token) setResetToken(token);
    }
  }, []);

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setNotice('');
    try {
      if (mode === 'login') {
        const data = await api('/auth/login', { method: 'POST', body: { identifier: form.identifier, password: form.password } });
        setUser(data.user);
      } else if (mode === 'register') {
        const data = await api('/auth/register', {
          method: 'POST',
          body: { email: form.email, username: form.username, fullName: form.fullName, password: form.password },
        });
        setUser(data.user);
        toast.push('Welcome to #ash Mesh.', 'success');
      } else if (mode === 'forgot') {
        const data = await api('/auth/password/forgot', { method: 'POST', body: { email: form.email } });
        setNotice(data.message + (data.delivery === 'not_configured'
          ? ' Email delivery is not configured on this deployment yet, so no email was sent.'
          : ''));
        if (data.devResetLink) setNotice(`${data.message} Development link: ${data.devResetLink}`);
      } else if (mode === 'reset') {
        await api('/auth/password/reset', { method: 'POST', body: { token: resetToken, password: newPassword } });
        toast.push('Password updated. Sign in now.', 'success');
        setMode('login');
        window.history.replaceState({}, '', '/');
      }
    } catch (err) {
      setErrors(err.data?.errors || {});
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const title = { login: 'Welcome back', register: 'Create your account', forgot: 'Recover your password', reset: 'Choose a new password' }[mode];

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-hero">
          <div className="brand-mark" style={{ margin: '0 auto', width: 52, height: 52, fontSize: 26, borderRadius: 16 }}>#</div>
          <h1>#ash Mesh</h1>
          <p>Your Network. Your Privacy. Your World.<br />Phone to Phone, City to City, Without Stopping.</p>
        </div>

        <div className="card">
          <h2 style={{ fontSize: 18, margin: '0 0 14px' }}>{title}</h2>
          <form onSubmit={submit} noValidate>
            {mode === 'login' ? (
              <>
                <Field label="Email or username">
                  <input className="input" value={form.identifier} onChange={set('identifier')} autoComplete="username" required />
                </Field>
                <Field label="Password">
                  <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required />
                </Field>
              </>
            ) : null}

            {mode === 'register' ? (
              <>
                <Field label="Full name">
                  <input className="input" value={form.fullName} onChange={set('fullName')} autoComplete="name" required />
                  {errors.fullName ? <div className="error-text">{errors.fullName}</div> : null}
                </Field>
                <Field label="Username" hint="Lowercase letters, numbers and underscores.">
                  <input className="input" value={form.username} onChange={set('username')} autoComplete="username" required />
                  {errors.username ? <div className="error-text">{errors.username}</div> : null}
                </Field>
                <Field label="Email">
                  <input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
                  {errors.email ? <div className="error-text">{errors.email}</div> : null}
                </Field>
                <Field label="Password" hint="At least 8 characters, with letters and numbers.">
                  <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required />
                  {errors.password ? <div className="error-text">{errors.password}</div> : null}
                </Field>
              </>
            ) : null}

            {mode === 'forgot' ? (
              <Field label="Account email">
                <input className="input" type="email" value={form.email} onChange={set('email')} required />
              </Field>
            ) : null}

            {mode === 'reset' ? (
              <>
                <Field label="Recovery token">
                  <input className="input" value={resetToken} onChange={(e) => setResetToken(e.target.value)} required />
                </Field>
                <Field label="New password" hint="At least 8 characters, with letters and numbers.">
                  <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
                </Field>
              </>
            ) : null}

            {notice ? <div className="success-text" style={{ marginBottom: 10, wordBreak: 'break-word' }}>{notice}</div> : null}

            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send recovery link' : 'Update password'}
            </button>
          </form>

          <div className="divider" />
          <div className="stack small">
            {mode === 'login' ? (
              <>
                <button className="link-btn" onClick={() => setMode('register')}>Create a new account</button>
                <button className="link-btn" onClick={() => setMode('forgot')}>Forgot your password?</button>
              </>
            ) : (
              <button className="link-btn" onClick={() => setMode('login')}>Back to sign in</button>
            )}
          </div>
        </div>

        <p className="tiny muted center" style={{ marginTop: 14 }}>
          Private messages are end-to-end encrypted on your device. By using #ash Mesh you agree to respectful,
          lawful use. Report abuse from any post or profile.
        </p>
      </div>
    </div>
  );
}
