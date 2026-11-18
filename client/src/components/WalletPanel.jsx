import React, { useCallback, useEffect, useState } from 'react';
import { api, formatTime, naira } from '../api.js';
import { Badge, Empty, Field, Spinner, useToast } from '../ui.jsx';

const PAYOUT_TONE = {
  pending: 'amber',
  under_review: 'amber',
  approved: 'green',
  processing: 'amber',
  paid: 'green',
  failed: 'red',
  cancelled: 'grey',
};

const PAYOUT_LABEL = {
  pending: 'Pending review',
  under_review: 'Under review',
  approved: 'Approved',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function Balance({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="tiny muted">{hint}</div> : null}
    </div>
  );
}

/**
 * Seller wallet. Every figure here is derived server-side from the immutable ledger;
 * nothing on this screen can set a balance, and a payout only completes after the
 * payment provider confirms the transfer.
 */
export default function WalletPanel() {
  const toast = useToast();
  const [wallet, setWallet] = useState(null);
  const [banks, setBanks] = useState({ configured: false, list: [], message: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [bankForm, setBankForm] = useState({ bankCode: '', accountNumber: '', accountName: '' });
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api('/wallet');
      setWallet(data.wallet);
      setBanks(data.banks || { configured: false, list: [], message: '' });
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveBank(event) {
    event.preventDefault();
    const bank = banks.list.find((b) => b.code === bankForm.bankCode);
    setBusy('bank');
    try {
      const data = await api('/wallet/bank-account', {
        method: 'POST',
        body: {
          bankCode: bankForm.bankCode,
          bankName: bank ? bank.name : bankForm.bankCode,
          accountNumber: bankForm.accountNumber,
          accountName: bankForm.accountName,
        },
      });
      toast.push(
        data.bankAccount?.status === 'verified'
          ? 'Bank account verified with the payment provider.'
          : 'Bank details saved. Payouts stay blocked until the account is verified.',
        data.bankAccount?.status === 'verified' ? 'success' : 'warn'
      );
      setBankForm({ bankCode: '', accountNumber: '', accountName: '' });
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function requestPayout(event) {
    event.preventDefault();
    const nairaAmount = Number(amount);
    if (!Number.isFinite(nairaAmount) || nairaAmount <= 0) {
      toast.push('Enter the amount you want to withdraw.', 'error');
      return;
    }
    setBusy('payout');
    try {
      const result = await api('/wallet/payouts', {
        method: 'POST',
        body: {
          amountMinor: Math.round(nairaAmount * 100),
          note: note.trim(),
          idempotencyKey: `payout-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
      });
      toast.push(
        result.duplicate ? 'This payout request already existed.' : 'Payout requested. The Founder reviews it before it is sent.',
        'success'
      );
      setAmount('');
      setNote('');
      if (result.wallet) setWallet(result.wallet);
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function cancelPayout(payout) {
    setBusy(payout.id);
    try {
      await api(`/wallet/payouts/${payout.id}/cancel`, { method: 'POST' });
      toast.push('Payout cancelled and the funds returned to your available balance.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  if (loading) return <Spinner label="Loading wallet" />;
  if (!wallet) return <div className="banner warn">Your wallet could not be loaded.</div>;

  const config = wallet.paymentConfig || {};
  const bank = wallet.bankAccount;

  return (
    <div className="stack">
      {!config.enabled ? (
        <div className="banner warn" role="status">
          {config.message || 'Online payment is not configured on this deployment.'} Balances, bank details and payout
          requests still work and are recorded server-side, but no money can move until the provider is configured.
        </div>
      ) : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Wallet</h3>
        <div className="stat-grid">
          <Balance label="Available" value={naira(wallet.availableMinor)} hint="Withdrawable after delivery confirmation" />
          <Balance label="Pending" value={naira(wallet.pendingMinor)} hint="Held until the buyer confirms delivery" />
          <Balance label="Lifetime sales" value={naira(wallet.lifetimeEarnedMinor)} hint="Before platform commission" />
          <Balance label="Minimum payout" value={naira(wallet.payoutMinimumMinor)} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Bank account for payouts</h3>
        {bank ? (
          <p className="small" style={{ marginTop: 0 }}>
            {bank.bankName} · {bank.maskedAccountNumber} · {bank.accountName || 'No account name'}{' '}
            <Badge tone={bank.status === 'verified' ? 'green' : bank.status === 'name_mismatch' ? 'amber' : 'grey'}>
              {bank.status === 'verified' ? 'Verified' : bank.status === 'name_mismatch' ? 'Name mismatch' : 'Unverified'}
            </Badge>
          </p>
        ) : (
          <p className="small muted" style={{ marginTop: 0 }}>No bank account saved yet. Add one to receive payouts.</p>
        )}
        {bank?.verificationNote ? <p className="tiny muted">{bank.verificationNote}</p> : null}
        <p className="tiny muted">
          Your account number is encrypted on the server and never shown in full. Changing bank details requires
          verification again before any payout is released.
        </p>
        <form onSubmit={saveBank} className="stack">
          <Field label="Bank" hint={banks.message || undefined}>
            <select
              value={bankForm.bankCode}
              onChange={(e) => setBankForm({ ...bankForm, bankCode: e.target.value })}
              required
              aria-label="Bank"
            >
              <option value="">{banks.list.length ? 'Select your bank' : 'Bank list unavailable'}</option>
              {banks.list.map((b) => (
                <option key={b.code} value={b.code}>{b.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Account number">
            <input
              inputMode="numeric"
              maxLength={10}
              value={bankForm.accountNumber}
              onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value.replace(/\D/g, '') })}
              placeholder="10-digit account number"
              required
              aria-label="Account number"
            />
          </Field>
          <Field label="Account name">
            <input
              value={bankForm.accountName}
              onChange={(e) => setBankForm({ ...bankForm, accountName: e.target.value })}
              placeholder="Name on the account"
              required
              aria-label="Account name"
            />
          </Field>
          <div>
            <button className="btn primary" disabled={busy === 'bank' || !banks.list.length}>
              {busy === 'bank' ? 'Verifying…' : 'Save bank details'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Request a payout</h3>
        <form onSubmit={requestPayout} className="stack">
          <Field label="Amount (₦)">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`At least ${wallet.payoutMinimumMinor / 100}`}
              required
              aria-label="Payout amount"
            />
          </Field>
          <Field label="Note (optional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-label="Payout note" />
          </Field>
          <div>
            <button className="btn primary" disabled={busy === 'payout' || bank?.status !== 'verified'}>
              {busy === 'payout' ? 'Requesting…' : 'Request payout'}
            </button>
            {bank?.status !== 'verified' ? (
              <span className="tiny muted" style={{ marginLeft: 10 }}>A verified bank account is required.</span>
            ) : null}
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Payouts</h3>
        {wallet.payouts.length === 0 ? (
          <Empty title="No payouts yet" hint="Requested payouts appear here with their real status." />
        ) : (
          <table className="table">
            <thead><tr><th>Requested</th><th>Amount</th><th>Status</th><th>Note</th><th /></tr></thead>
            <tbody>
              {wallet.payouts.map((p) => (
                <tr key={p.id}>
                  <td className="muted">{formatTime(p.requestedAt)}</td>
                  <td>{naira(p.amountMinor)}</td>
                  <td>
                    <Badge tone={PAYOUT_TONE[p.status] || 'grey'}>{PAYOUT_LABEL[p.status] || p.status}</Badge>
                    {p.failureReason ? <div className="tiny muted">{p.failureReason}</div> : null}
                  </td>
                  <td className="muted small">{p.note || '—'}</td>
                  <td>
                    {p.canCancel ? (
                      <button className="btn ghost sm" disabled={busy === p.id} onClick={() => cancelPayout(p)}>
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Transaction history</h3>
        {wallet.ledger.length === 0 ? (
          <Empty title="No wallet activity yet" hint="Sales, releases, commission and refunds are recorded here." />
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Entry</th><th>Bucket</th><th>Amount</th></tr></thead>
            <tbody>
              {wallet.ledger.map((entry) => (
                <tr key={entry.id}>
                  <td className="muted">{formatTime(entry.createdAt)}</td>
                  <td>{entry.label}</td>
                  <td className="muted small">{entry.bucket}</td>
                  <td style={{ color: entry.direction === 'credit' ? 'var(--green, #00ff88)' : undefined }}>
                    {entry.direction === 'credit' ? '+' : '−'}{naira(entry.amountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
