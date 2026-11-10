import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, formatTime, naira } from '../api.js';
import { pct } from '../format.js';
import { useAuth } from '../App.jsx';
import { Avatar, Badge, ConfirmDialog, Empty, Field, Modal, Spinner, useToast } from '../ui.jsx';

const CATEGORIES = ['general', 'electronics', 'phones', 'fashion', 'home', 'vehicles', 'services', 'education', 'agriculture', '3d-assets'];

const STATUS_TONE = {
  pending_payment: 'amber', paid: 'green', shipped: 'green', completed: 'green',
  cancelled: 'grey', refunded: 'grey', disputed: 'amber',
};

export default function Market() {
  const { user } = useAuth();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState('browse');
  const [listings, setListings] = useState(null);
  const [mine, setMine] = useState([]);
  const [orders, setOrders] = useState([]);
  const [verification, setVerification] = useState({ verifications: [], isVerifiedSeller: false });
  const [tiers, setTiers] = useState([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [detail, setDetail] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', category: 'general', location: '', price: '' });
  const [files, setFiles] = useState([]);
  const [deliveryNote, setDeliveryNote] = useState('');
  const [paymentNotice, setPaymentNotice] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [fraud, setFraud] = useState(null);
  const [fraudText, setFraudText] = useState('');
  const [verifyForm, setVerifyForm] = useState({ businessName: '', idType: 'nin', idNumber: '' });
  const [verifyDoc, setVerifyDoc] = useState(null);

  const loadBrowse = useCallback(async () => {
    const search = new URLSearchParams();
    if (query.trim()) search.set('q', query.trim());
    if (category) search.set('category', category);
    try {
      const data = await api(`/market/listings?${search.toString()}`);
      setListings(data.listings);
      setTiers(data.commissionTiers || []);
    } catch (err) {
      toast.push(err.message, 'error');
      setListings([]);
    }
  }, [query, category, toast]);

  const loadMine = useCallback(async () => {
    try {
      const [m, o, v] = await Promise.all([api('/market/mine'), api('/market/orders'), api('/market/verification/mine')]);
      setMine(m.listings);
      setOrders(o.orders);
      setVerification(v);
    } catch (err) {
      toast.push(err.message, 'error');
    }
  }, [toast]);

  useEffect(() => { loadBrowse(); }, [loadBrowse]);
  useEffect(() => { loadMine(); }, [loadMine]);

  // Load a single listing for the /market/:id route.
  useEffect(() => {
    if (!id) { setDetail(null); return; }
    api(`/market/listings/${id}`).then((d) => setDetail(d.listing)).catch((err) => toast.push(err.message, 'error'));
  }, [id, toast]);

  // Return leg of a real payment provider redirect.
  useEffect(() => {
    const reference = params.get('verify');
    if (!reference) return;
    (async () => {
      try {
        const result = await api(`/market/payments/verify?reference=${encodeURIComponent(reference)}`);
        setPaymentNotice({
          ok: result.verified,
          text: result.verified
            ? 'Payment confirmed by the provider. Your order is paid.'
            : `Payment not confirmed (provider status: ${result.providerStatus}). Nothing was marked as paid.`,
        });
        loadMine();
      } catch (err) {
        setPaymentNotice({ ok: false, text: err.message });
      } finally {
        const next = new URLSearchParams(params);
        next.delete('verify');
        setParams(next, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createListing(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const body = new FormData();
      Object.entries(form).forEach(([key, value]) => body.append(key, value));
      files.forEach((file) => body.append('media', file));
      const { listing } = await api('/market/listings', { method: 'POST', form: body });
      setCreating(false);
      setForm({ title: '', description: '', category: 'general', location: '', price: '' });
      setFiles([]);
      toast.push('Listing published.', 'success');
      await loadMine();
      await loadBrowse();
      navigate(`/market/${listing.id}`);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function buy(listing) {
    setBusy(true);
    try {
      const { order, payment } = await api(`/market/listings/${listing.id}/orders`, {
        method: 'POST',
        body: { deliveryNote },
      });
      setDeliveryNote('');
      await loadMine();
      if (payment?.status === 'initialized' && payment.authorizationUrl) {
        window.location.href = payment.authorizationUrl;
        return;
      }
      setPaymentNotice({
        ok: false,
        text: payment?.message || 'The order was recorded, but online payment is unavailable right now.',
      });
      setDetail(null);
      setTab('orders');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function orderAction(order, status) {
    setBusy(true);
    try {
      await api(`/market/orders/${order.id}/status`, { method: 'POST', body: { status } });
      toast.push('Order updated.', 'success');
      await loadMine();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryPayment(order) {
    setBusy(true);
    try {
      const { payment } = await api(`/market/orders/${order.id}/pay`, { method: 'POST' });
      if (payment?.authorizationUrl) { window.location.href = payment.authorizationUrl; return; }
      setPaymentNotice({ ok: false, text: payment?.message || 'Payment provider is not available.' });
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitVerification(event) {
    event.preventDefault();
    if (!verifyDoc) { toast.push('Attach an identity document.', 'error'); return; }
    setBusy(true);
    try {
      const body = new FormData();
      body.append('businessName', verifyForm.businessName);
      body.append('idType', verifyForm.idType);
      body.append('idNumber', verifyForm.idNumber);
      body.append('document', verifyDoc);
      await api('/market/verification', { method: 'POST', form: body });
      setVerifyForm({ businessName: '', idType: 'nin', idNumber: '' });
      setVerifyDoc(null);
      toast.push('Verification submitted for review.', 'success');
      await loadMine();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitFraud() {
    if (!fraudText.trim()) { toast.push('Describe what happened.', 'error'); return; }
    setBusy(true);
    try {
      await api('/market/fraud-report', {
        method: 'POST',
        body: { listingId: fraud.listing?.id, orderId: fraud.order?.id, details: fraudText, reason: 'suspected_fraud' },
      });
      setFraud(null);
      setFraudText('');
      toast.push('Fraud report submitted. Moderators will review it.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const card = (listing) => (
    <Link key={listing.id} to={`/market/${listing.id}`} className="listing-card">
      <div className="listing-thumb">
        {listing.media?.[0]?.url ? <img src={listing.media[0].url} alt="" loading="lazy" /> : <span>#ash</span>}
      </div>
      <div className="listing-body">
        <div className="listing-title">{listing.title}</div>
        <div className="price">{naira(listing.priceMinor)}</div>
        <div className="tiny muted">
          {listing.location || listing.category}
          {listing.seller?.verifiedSeller ? ' · verified seller' : ''}
        </div>
      </div>
    </Link>
  );

  return (
    <div className="stack">
      {paymentNotice ? (
        <div className={`banner ${paymentNotice.ok ? 'ok' : 'warn'}`} role="status">
          {paymentNotice.text}
          <button className="btn ghost sm" style={{ marginLeft: 12 }} onClick={() => setPaymentNotice(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0 }}>Marketplace</h2>
          <button className="btn primary" onClick={() => setCreating(true)}>Sell something</button>
        </div>
        <div className="tabs" style={{ marginTop: 12 }}>
          {[['browse', 'Browse'], ['orders', `Orders (${orders.length})`], ['sell', `My listings (${mine.length})`], ['verify', 'Seller verification']].map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      </div>

      {tab === 'browse' ? (
        <>
          <div className="card row wrap" style={{ gap: 8 }}>
            <input
              placeholder="Search listings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, minWidth: 180 }}
              aria-label="Search listings"
            />
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {!listings ? <Spinner label="Loading listings" /> : null}
          {listings?.length === 0 ? <Empty title="No listings match" hint="Try a different search or category." /> : null}
          <div className="listing-grid">{listings?.map(card)}</div>
          {tiers.length ? (
            <div className="card">
              <h4 style={{ marginTop: 0 }}>Approved commission structure</h4>
              <table className="table">
                <thead><tr><th>Transaction amount</th><th>Commission</th></tr></thead>
                <tbody>
                  {tiers.map((tier) => (
                    <tr key={tier.label}>
                      <td>{tier.label}</td>
                      <td>{pct(tier.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'orders' ? (
        <div className="card">
          {orders.length === 0 ? <Empty title="No orders yet" hint="Purchases and sales appear here." /> : null}
          {orders.map((order) => (
            <div className="order-row" key={order.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{order.listing?.title || 'Listing'}</div>
                <div className="tiny muted">
                  {order.role === 'buyer' ? `Seller @${order.seller?.username}` : `Buyer @${order.buyer?.username}`} · {formatTime(order.createdAt)}
                </div>
                <div className="tiny muted">
                  {naira(order.amountMinor)} · commission {naira(order.commissionMinor)} ({pct(order.commissionRate)}) · payout {naira(order.payoutMinor)}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Badge tone={STATUS_TONE[order.status] || 'grey'}>{order.status.replace(/_/g, ' ')}</Badge>
                {order.role === 'buyer' && order.status === 'pending_payment' ? (
                  <button className="btn primary sm" disabled={busy} onClick={() => retryPayment(order)}>Pay now</button>
                ) : null}
                {order.role === 'seller' && order.status === 'paid' ? (
                  <button className="btn sm" disabled={busy} onClick={() => orderAction(order, 'shipped')}>Mark shipped</button>
                ) : null}
                {order.role === 'buyer' && order.status === 'shipped' ? (
                  <button className="btn sm" disabled={busy} onClick={() => orderAction(order, 'completed')}>Confirm received</button>
                ) : null}
                {order.status === 'pending_payment' ? (
                  <button className="btn ghost sm" disabled={busy} onClick={() => orderAction(order, 'cancelled')}>Cancel</button>
                ) : null}
                <button className="btn ghost sm danger-text" onClick={() => setFraud({ order })}>Report fraud</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'sell' ? (
        <div className="card">
          {mine.length === 0 ? <Empty title="No listings yet" hint="Publish your first product." action={<button className="btn primary" onClick={() => setCreating(true)}>Create listing</button>} /> : null}
          {mine.map((listing) => (
            <div className="order-row" key={listing.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{listing.title}</div>
                <div className="tiny muted">{naira(listing.priceMinor)} · {listing.status} · {listing.views} views</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Link className="btn ghost sm" to={`/market/${listing.id}`}>View</Link>
                <button className="btn ghost sm danger-text" onClick={() => setConfirmDelete(listing)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'verify' ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Seller verification</h3>
          {verification.isVerifiedSeller ? (
            <p className="muted">Your seller account is verified. Buyers see a verified badge on your listings.</p>
          ) : (
            <>
              <p className="muted small">
                Verification is reviewed by a moderator. Your identity document is stored privately and is only accessible to reviewers.
              </p>
              {verification.verifications.some((v) => v.status === 'pending') ? (
                <div className="banner info">You already have a verification under review.</div>
              ) : (
                <form onSubmit={submitVerification} className="stack" style={{ maxWidth: 460 }}>
                  <Field label="Business or display name"><input value={verifyForm.businessName} onChange={(e) => setVerifyForm({ ...verifyForm, businessName: e.target.value })} required maxLength={120} /></Field>
                  <Field label="ID type">
                    <select value={verifyForm.idType} onChange={(e) => setVerifyForm({ ...verifyForm, idType: e.target.value })}>
                      <option value="nin">NIN</option>
                      <option value="drivers_license">Driver's licence</option>
                      <option value="passport">International passport</option>
                      <option value="cac">CAC registration</option>
                    </select>
                  </Field>
                  <Field label="ID number"><input value={verifyForm.idNumber} onChange={(e) => setVerifyForm({ ...verifyForm, idNumber: e.target.value })} required /></Field>
                  <Field label="Identity document" hint="Image or PDF, max 10 MB">
                    <input type="file" accept="image/*,application/pdf" onChange={(e) => setVerifyDoc(e.target.files?.[0] || null)} />
                  </Field>
                  <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? <span className="spinner" /> : 'Submit for review'}</button>
                </form>
              )}
            </>
          )}
          {verification.verifications.length ? (
            <div style={{ marginTop: 16 }}>
              <h4>Your submissions</h4>
              {verification.verifications.map((v) => (
                <div className="row tiny" key={v.id} style={{ justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                  <span>{v.business_name} · {v.id_type}</span>
                  <span className="row" style={{ gap: 8 }}>
                    <Badge tone={v.status === 'approved' ? 'green' : v.status === 'rejected' ? 'red' : 'amber'}>{v.status}</Badge>
                    <span className="muted">{formatTime(v.created_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {creating ? (
        <Modal title="Create a listing" onClose={() => setCreating(false)}>
          <form onSubmit={createListing} className="stack">
            <Field label="Title"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={140} /></Field>
            <Field label="Description"><textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={4000} /></Field>
            <div className="grid-2">
              <Field label="Category">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Location"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
            </div>
            <Field label="Price (₦)" hint="Commission is calculated automatically when a buyer orders.">
              <input type="number" min="1" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
            </Field>
            <Field label="Photos or videos" hint="Up to 6 files">
              <input type="file" accept="image/*,video/*" multiple onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, 6))} />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Publish listing'}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {detail ? (
        <Modal title={detail.title} onClose={() => { setDetail(null); navigate('/market'); }}>
          {detail.media?.length ? (
            <div className="listing-media-row">
              {detail.media.map((m) => (
                m.url.match(/\.(mp4|webm|mov)$/i)
                  ? <video key={m.id} src={m.url} controls preload="metadata" />
                  : <img key={m.id} src={m.url} alt="" />
              ))}
            </div>
          ) : null}
          <div className="price" style={{ fontSize: 22, margin: '10px 0' }}>{naira(detail.priceMinor)}</div>
          {detail.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</p> : null}
          <div className="row tiny muted" style={{ gap: 14 }}>
            <span>{detail.category}</span>
            {detail.location ? <span>{detail.location}</span> : null}
            <span>{detail.views} views</span>
          </div>
          {detail.seller ? (
            <div className="row" style={{ marginTop: 12, gap: 10 }}>
              <Avatar user={detail.seller} size={38} />
              <div>
                <div style={{ fontWeight: 600 }}>{detail.seller.fullName || detail.seller.username}</div>
                <div className="tiny muted">@{detail.seller.username}{detail.seller.verifiedSeller ? ' · verified seller' : ''}</div>
              </div>
            </div>
          ) : null}
          {detail.commissionPreview ? (
            <p className="tiny muted" style={{ marginTop: 10 }}>
              Buyer pays {naira(detail.priceMinor)}. Platform commission {naira(detail.commissionPreview.commissionMinor)} ({pct(detail.commissionPreview.rate)}),
              seller receives {naira(detail.commissionPreview.payoutMinor)}.
            </p>
          ) : null}
          {detail.isOwner ? (
            <div className="row" style={{ marginTop: 14, gap: 8 }}>
              <Badge tone="grey">Your listing</Badge>
              <button className="btn ghost sm danger-text" onClick={() => setConfirmDelete(detail)}>Delete listing</button>
            </div>
          ) : (
            <>
              <Field label="Delivery instructions (optional)">
                <textarea rows={2} value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} maxLength={400} />
              </Field>
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <button className="btn primary" disabled={busy} onClick={() => buy(detail)}>Buy now</button>
                <button className="btn ghost" onClick={() => setFraud({ listing: detail })}>Report listing</button>
              </div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                Payment is completed by the payment provider. An order is only marked paid after the provider confirms the transaction.
              </p>
            </>
          )}
        </Modal>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete listing"
          message="The listing will be removed from the marketplace. Existing orders are not affected."
          confirmLabel="Delete listing"
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api(`/market/listings/${confirmDelete.id}`, { method: 'DELETE' });
              toast.push('Listing removed.', 'success');
              setConfirmDelete(null);
              setDetail(null);
              await loadMine();
              await loadBrowse();
            } catch (err) {
              toast.push(err.message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {fraud ? (
        <Modal
          title="Report fraud"
          onClose={() => setFraud(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setFraud(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={submitFraud}>Submit report</button>
            </>
          }
        >
          <p className="muted small">Describe what happened. Moderators investigate fraud reports; false reports are also reviewed.</p>
          <textarea rows={4} value={fraudText} onChange={(e) => setFraudText(e.target.value)} maxLength={2000} placeholder="What went wrong?" />
        </Modal>
      ) : null}
    </div>
  );
}
