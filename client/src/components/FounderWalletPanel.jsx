import React, { useCallback, useEffect, useState } from 'react';
import { api, formatTime, naira } from '../api.js';
import { Badge, Empty, Field, Spinner, useToast } from '../ui.jsx';

const PAYOUT_LABEL = {
  pending: 'Pending review',
  under_review: 'Under review',
  approved: 'Approved',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const PAYOUT_TONE = {
  pending: 'amber',
  under_review: 'amber',
  approved: 'green',
  processing: 'amber',
  paid: 'green',
  failed: 'red',
  cancelled: 'grey',
};

/**
 * Founder-only marketplace finance panel: real commission totals by approved tier,
 * the seller payout queue and provider-confirmed refunds. Payout approval and
 * processing are separate deliberate steps; nothing here can mark a payout paid.
 */
export default function FounderWalletPanel() {
  const toast = useToast();
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});
  const [refund, setRefund] = useState({ orderId: '', amount: '', reason: '' });

  const load = useCallback(async () => {
    try {
      const data = await api('/wallet/founder');
      setOverview(data.overview);
    } catch (err) {
      toast.push(err.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function review(payout, decision) {
    const note = (notes[payout.id] || '').trim();
    if (decision === 'reject' && !note) {
      toast.push('Record the reason before rejecting a payout.', 'error');
      return;
    }
    setBusy(payout.id);
    try {
      await api(`/wallet/payouts/${payout.id}/review`, { method: 'POST', body: { decision, note } });
      toast.push(`Payout ${decision === 'reject' ? 'rejected' : decision === 'approve' ? 'approved' : 'moved under review'}.`, 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function process(payout) {
    setBusy(payout.id);
    try {
      const result = await api(`/wallet/payouts/${payout.id}/process`, { method: 'POST' });
      toast.push(result.provider?.message || 'Transfer submitted to the provider. It is only marked paid after provider confirmation.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function submitRefund(event) {
    event.preventDefault();
    const orderId = refund.orderId.trim();
    if (!orderId) {
      toast.push('Enter the order ID to refund.', 'error');
      return;
    }
    const body = { reason: refund.reason.trim() };
    if (refund.amount.trim()) body.amountMinor = Math.round(Number(refund.amount) * 100);
    setBusy('refund');
    try {
      const result = await api(`/wallet/orders/${orderId}/refund`, { method: 'POST', body });
      toast.push(
        result.provider?.message || `Refund recorded with status ${result.refund?.status}. Balances change only after provider confirmation.`,
        result.refund?.status === 'failed' ? 'error' : 'success'
      );
      setRefund({ orderId: '', amount: '', reason: '' });
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  if (!overview) return <Spinner label="Loading marketplace finance" />;
  const totals = overview.totals;

  return (
    <div className="stack">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Marketplace finance</h3>
        {!overview.paymentConfig?.enabled ? (
          <p className="tiny muted">{overview.paymentConfig?.message}</p>
        ) : (
          <p className="tiny muted">Payment provider: {overview.paymentConfig.mode} mode.</p>
        )}
        <div className="stat-grid">
          <div className="stat"><div className="stat-label">Paid orders</div><div className="stat-value">{totals.orders}</div></div>
          <div className="stat"><div className="stat-label">Sales volume</div><div className="stat-value">{naira(totals.salesMinor)}</div></div>
          <div className="stat"><div className="stat-label">Commission earned</div><div className="stat-value">{naira(totals.commissionMinor)}</div></div>
          <div className="stat"><div className="stat-label">Seller share</div><div className="stat-value">{naira(totals.sellerMinor)}</div></div>
          <div className="stat"><div className="stat-label">Platform balance</div><div className="stat-value">{naira(overview.platformBalanceMinor)}</div></div>
          <div className="stat">
            <div className="stat-label">Ledger integrity</div>
            <div className="stat-value">{overview.ledgerIntegrity.duplicateKeys === 0 ? 'OK' : 'Duplicate keys'}</div>
            <div className="tiny muted">{overview.ledgerIntegrity.entries} entries</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Commission by approved tier</h3>
        {overview.commissionByRate.length === 0 ? (
          <Empty title="No settled orders yet" />
        ) : (
          <table className="table">
            <thead><tr><th>Tier</th><th>Orders</th><th>Sales</th><th>Commission</th></tr></thead>
            <tbody>
              {overview.commissionByRate.map((row) => (
                <tr key={row.rate}>
                  <td>{row.percentLabel}</td>
                  <td>{row.orders}</td>
                  <td>{naira(row.salesMinor)}</td>
                  <td>{naira(row.commissionMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Seller payout queue</h3>
        {overview.payoutQueue.length === 0 ? (
          <Empty title="No open payout requests" hint="Requests appear here as soon as a seller withdraws." />
        ) : (
          <div className="stack">
            {overview.payoutQueue.map((p) => (
              <div key={p.id} className="card" style={{ padding: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{naira(p.amountMinor)} · {p.seller ? `@${p.seller.username}` : 'seller'}</div>
                    <div className="tiny muted">
                      {p.bank ? `${p.bank.bankName} ••••${p.bank.accountLast4} · ${p.bank.accountName}` : 'No bank account'}
                      {' · '}requested {formatTime(p.requestedAt)}
                    </div>
                  </div>
                  <Badge tone={PAYOUT_TONE[p.status] || 'grey'}>{PAYOUT_LABEL[p.status] || p.status}</Badge>
                </div>
                {p.failureReason ? <div className="tiny" style={{ color: '#ff9f9f' }}>{p.failureReason}</div> : null}
                <input
                  placeholder="Review note (required to reject)"
                  value={notes[p.id] || ''}
                  onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })}
                  maxLength={300}
                  aria-label={`Review note for payout ${p.id}`}
                  style={{ marginTop: 8 }}
                />
                <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                  {p.status === 'pending' ? (
                    <button className="btn ghost sm" disabled={busy === p.id} onClick={() => review(p, 'review')}>Move under review</button>
                  ) : null}
                  {['pending', 'under_review'].includes(p.status) ? (
                    <button className="btn primary sm" disabled={busy === p.id} onClick={() => review(p, 'approve')}>Approve</button>
                  ) : null}
                  {['pending', 'under_review', 'approved'].includes(p.status) ? (
                    <button className="btn ghost sm" disabled={busy === p.id} onClick={() => review(p, 'reject')}>Reject</button>
                  ) : null}
                  {p.status === 'approved' ? (
                    <button className="btn primary sm" disabled={busy === p.id} onClick={() => process(p)}>
                      {busy === p.id ? 'Sending…' : 'Send to provider'}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Refund an order</h3>
        <p className="tiny muted" style={{ marginTop: -6 }}>
          A refund is only settled after the payment provider confirms it. The seller share and platform commission on
          that order are reversed together, and the reversal is refused if the seller balance cannot absorb it.
        </p>
        <form onSubmit={submitRefund} className="stack">
          <Field label="Order ID">
            <input value={refund.orderId} onChange={(e) => setRefund({ ...refund, orderId: e.target.value })} placeholder="ord_…" required aria-label="Order ID" />
          </Field>
          <Field label="Amount (₦)" hint="Leave empty to refund the full order amount.">
            <input inputMode="decimal" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} aria-label="Refund amount" />
          </Field>
          <Field label="Reason">
            <input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} maxLength={300} required aria-label="Refund reason" />
          </Field>
          <div>
            <button className="btn primary" disabled={busy === 'refund'}>Request refund</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent refunds</h3>
        {overview.recentRefunds.length === 0 ? (
          <Empty title="No refunds recorded" />
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Order</th><th>Amount</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {overview.recentRefunds.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{formatTime(r.createdAt)}</td>
                  <td className="muted small">{r.orderId}</td>
                  <td>{naira(r.amountMinor)}</td>
                  <td>
                    <Badge tone={r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}>{r.status}</Badge>
                    {r.failureReason ? <div className="tiny muted">{r.failureReason}</div> : null}
                  </td>
                  <td className="muted small">{r.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
