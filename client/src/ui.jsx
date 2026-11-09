import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/* ------------------------------- toasts ---------------------------------- */
const ToastCtx = createContext({ push: () => {} });

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ------------------------------- avatar ---------------------------------- */
export function Avatar({ user, size = 40, square = false, className = '' }) {
  const initials = (user?.fullName || user?.username || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  if (user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.fullName || user.username}
        className={`avatar ${square ? 'sq' : ''} ${className}`}
        style={{ ...style, objectFit: 'cover' }}
        loading="lazy"
      />
    );
  }
  return (
    <div className={`avatar ${square ? 'sq' : ''} ${className}`} style={style} aria-hidden="true">
      {initials || '#'}
    </div>
  );
}

/* -------------------------------- modal ---------------------------------- */
export function Modal({ title, children, onClose, actions }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        {title ? <h3>{title}</h3> : null}
        {children}
        {actions ? <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>{actions}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------ primitives -------------------------------- */
export function Spinner({ label = 'Loading' }) {
  return (
    <div className="row muted small" style={{ padding: '18px 0', justifyContent: 'center' }}>
      <span className="spinner" /> {label}…
    </div>
  );
}

export function Empty({ title, hint, action }) {
  return (
    <div className="card center" style={{ padding: '28px 18px' }}>
      <div style={{ fontSize: 26, marginBottom: 6 }}>#</div>
      <div style={{ fontWeight: 700 }}>{title}</div>
      {hint ? <div className="muted small" style={{ marginTop: 4 }}>{hint}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function Field({ label, children, hint }) {
  return (
    <div className="field">
      {label ? <label>{label}</label> : null}
      {children}
      {hint ? <div className="tiny muted">{hint}</div> : null}
    </div>
  );
}

export function Badge({ tone = 'grey', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function NetworkChip({ label, tone = 'green' }) {
  return (
    <span className="net-chip" title="Universal Adaptive Routing">
      <span className={`dot ${tone === 'green' ? '' : tone}`} /> {label}
    </span>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = true, onCancel, onConfirm, busy }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null} {confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>{message}</p>
    </Modal>
  );
}
