// #ash Mesh — marketplace: listings, orders, commission, payments, seller verification.
import crypto from 'node:crypto';
import express from 'express';
import { db, uid, now, parseJSON, toPublicUser, notify, audit, areFriends, isBlocked } from './db.js';
import { requireAuth, upload, saveMedia, rateLimit, clean, clampInt, badRequest, clientIp } from './lib.js';
import { screenContent } from './moderation.js';
import * as paystack from './paystack.js';
import { recordOrderPaid, releaseOrderFunds, completeRefund, settlePayout } from './wallet.js';

const router = express.Router();

/* ------------------------- approved commission table ----------------------
   ₦1–₦100,000            3%
   ₦100,001–₦500,000      5%
   ₦500,001–₦1,000,000    3%
   ₦1,000,001–₦5,000,000  2.5%
   ₦5,000,001–₦10,000,000 2%
   Above ₦10,000,000      held for Founder review — no rate was authorised for
                          this band, so no commission is calculated and the
                          order can never be charged or released automatically.
   Rates must not be changed without authorisation.
-------------------------------------------------------------------------- */
export const FOUNDER_REVIEW_THRESHOLD_MINOR = 1000000000; // ₦10,000,000 in kobo

export const COMMISSION_TIERS = [
  { min: 1, max: 100000, rate: 0.03, label: '₦1 – ₦100,000' },
  { min: 100001, max: 500000, rate: 0.05, label: '₦100,001 – ₦500,000' },
  { min: 500001, max: 1000000, rate: 0.03, label: '₦500,001 – ₦1,000,000' },
  { min: 1000001, max: 5000000, rate: 0.025, label: '₦1,000,001 – ₦5,000,000' },
  { min: 5000001, max: 10000000, rate: 0.02, label: '₦5,000,001 – ₦10,000,000' },
];

/** The band above ₦10,000,000 has no authorised rate: it is a Founder review band. */
export const FOUNDER_REVIEW_BAND = { above: 10000000, rate: null, label: 'Above ₦10,000,000', action: 'founder_review' };

/**
 * Resolve the approved commission for an amount in kobo. This is the single
 * authority for pricing: routes never accept a rate, commission or payout from a client.
 */
export function resolveCommission(amountMinor) {
  const empty = { valid: false, held: false, rate: null, commissionMinor: null, payoutMinor: null, tier: null, reason: 'invalid_amount' };
  if (!Number.isInteger(amountMinor) || amountMinor < 100) return empty;
  if (amountMinor > FOUNDER_REVIEW_THRESHOLD_MINOR) {
    return { ...empty, valid: true, held: true, reason: 'founder_review', tier: FOUNDER_REVIEW_BAND.label };
  }
  const naira = amountMinor / 100;
  const tier = COMMISSION_TIERS.find((t) => naira >= t.min && naira <= t.max);
  if (!tier) return empty;
  const commissionMinor = Math.round(amountMinor * tier.rate);
  return {
    valid: true,
    held: false,
    rate: tier.rate,
    commissionMinor,
    payoutMinor: amountMinor - commissionMinor,
    tier: tier.label,
    reason: null,
  };
}

export function commissionRate(amountNaira) {
  const amountMinor = Math.round(Number(amountNaira) * 100);
  const resolved = resolveCommission(amountMinor);
  return resolved.held ? null : (resolved.rate ?? 0);
}

/** Commission in minor units (kobo), rounded to the nearest kobo. */
export function commissionFor(amountMinor) {
  const resolved = resolveCommission(amountMinor);
  return {
    valid: resolved.valid,
    held: resolved.held,
    rate: resolved.rate,
    commissionMinor: resolved.commissionMinor,
    payoutMinor: resolved.payoutMinor,
    tier: resolved.tier,
    reason: resolved.reason,
  };
}

function serializeListing(row, viewerId) {
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(row.seller_id);
  const media = parseJSON(row.media, []);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    priceMinor: row.price_minor,
    price: row.price_minor / 100,
    currency: row.currency,
    location: row.location,
    status: row.status,
    views: row.views,
    createdAt: row.created_at,
    seller: toPublicUser(seller, viewerId),
    media: media.map((id) => ({ id, url: `/api/media/${id}` })),
    isOwner: row.seller_id === viewerId,
    commissionPreview: commissionFor(row.price_minor),
  };
}

router.get('/market/listings', requireAuth, (req, res) => {
  const q = clean(req.query.q, 80);
  const category = clean(req.query.category, 40);
  const sellerId = clean(req.query.sellerId, 60);
  const limit = clampInt(req.query.limit, 1, 40, 20);
  const cursor = clean(req.query.cursor, 40);

  const where = ["l.status = 'active'", 'u.status = ?'];
  const params = ['active'];
  if (q) { where.push('(l.title LIKE ? OR l.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category && category !== 'all') { where.push('l.category = ?'); params.push(category); }
  if (sellerId) { where.push('l.seller_id = ?'); params.push(sellerId); }
  if (cursor) { where.push('l.created_at < ?'); params.push(cursor); }
  where.push('NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = l.seller_id) OR (b.blocker_id = l.seller_id AND b.blocked_id = ?))');
  params.push(req.user.id, req.user.id);

  const rows = db.prepare(
    `SELECT l.* FROM marketplace_listings l JOIN users u ON u.id = l.seller_id
     WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ?`
  ).all(...params, limit);
  res.json({
    listings: rows.map((r) => serializeListing(r, req.user.id)),
    nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null,
    commissionTiers: COMMISSION_TIERS,
    founderReviewBand: FOUNDER_REVIEW_BAND,
  });
});

router.get('/market/listings/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(req.params.id);
  if (!row || row.status === 'removed') return res.status(404).json({ error: 'not_found', message: 'Listing not found.' });
  if (row.seller_id !== req.user.id) db.prepare('UPDATE marketplace_listings SET views = views + 1 WHERE id = ?').run(row.id);
  res.json({ listing: serializeListing(row, req.user.id) });
});

router.get('/market/mine', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM marketplace_listings WHERE seller_id = ? AND status != 'removed' ORDER BY created_at DESC").all(req.user.id);
  res.json({ listings: rows.map((r) => serializeListing(r, req.user.id)) });
});

router.post('/market/listings', requireAuth, rateLimit({ name: 'listing', limit: 30, windowMs: 60 * 60 * 1000 }), upload.array('media', 6), (req, res) => {
  const title = clean(req.body.title, 140);
  const description = clean(req.body.description, 4000);
  const category = clean(req.body.category, 40) || 'general';
  const location = clean(req.body.location, 120);
  const priceNaira = Number(req.body.price);

  if (title.length < 3) return badRequest(res, 'Enter a listing title (at least 3 characters).');
  if (!Number.isFinite(priceNaira) || priceNaira < 1) return badRequest(res, 'Enter a valid price of at least ₦1.');
  if (priceNaira > 100000000) return badRequest(res, 'Price exceeds the supported marketplace limit.');
  const priceMinor = Math.round(priceNaira * 100);

  const mediaIds = [];
  for (const file of req.files || []) {
    try {
      const kind = String(file.mimetype || '').startsWith('video/') ? 'video' : 'image';
      const media = saveMedia({ file, ownerId: req.user.id, kind });
      mediaIds.push(media.id);
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Upload failed.' });
    }
  }

  const id = uid('lst_');
  db.prepare(
    `INSERT INTO marketplace_listings (id, seller_id, title, description, category, price_minor, currency, location, media, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)`
  ).run(id, req.user.id, title, description, category, priceMinor, 'NGN', location, JSON.stringify(mediaIds), now(), now());
  // Marketplace listings are screened too: scams, counterfeit goods and bait prices enter
  // the human review queue with the original text kept as evidence.
  screenContent({ targetType: 'listing', targetId: id, authorId: req.user.id, text: `${title}\n${description}` });

  audit(req.user.id, 'listing.create', 'listing', id, { priceMinor }, clientIp(req));
  res.status(201).json({ listing: serializeListing(db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(id), req.user.id) });
});

router.patch('/market/listings/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(req.params.id);
  if (!row || row.seller_id !== req.user.id) return res.status(404).json({ error: 'not_found', message: 'Listing not found.' });
  const title = req.body.title !== undefined ? clean(req.body.title, 140) : row.title;
  const description = req.body.description !== undefined ? clean(req.body.description, 4000) : row.description;
  const category = req.body.category !== undefined ? clean(req.body.category, 40) : row.category;
  const location = req.body.location !== undefined ? clean(req.body.location, 120) : row.location;
  let priceMinor = row.price_minor;
  if (req.body.price !== undefined) {
    const priceNaira = Number(req.body.price);
    if (!Number.isFinite(priceNaira) || priceNaira < 1) return badRequest(res, 'Enter a valid price.');
    priceMinor = Math.round(priceNaira * 100);
  }
  const status = ['active', 'sold', 'draft'].includes(req.body.status) ? req.body.status : row.status;
  db.prepare('UPDATE marketplace_listings SET title=?, description=?, category=?, location=?, price_minor=?, status=?, updated_at=? WHERE id=?')
    .run(title, description, category, location, priceMinor, status, now(), row.id);
  audit(req.user.id, 'listing.update', 'listing', row.id, { status }, clientIp(req));
  res.json({ listing: serializeListing(db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(row.id), req.user.id) });
});

router.delete('/market/listings/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(req.params.id);
  if (!row || row.seller_id !== req.user.id) return res.status(404).json({ error: 'not_found', message: 'Listing not found.' });
  if (req.body?.confirm !== true && req.query.confirm !== 'true') {
    return res.status(428).json({ error: 'confirmation_required', message: 'Confirm removal of this listing.' });
  }
  db.prepare("UPDATE marketplace_listings SET status = 'removed', updated_at = ? WHERE id = ?").run(now(), row.id);
  audit(req.user.id, 'listing.remove', 'listing', row.id, {}, clientIp(req));
  res.json({ ok: true });
});

/* --------------------------------- orders --------------------------------- */

function serializeOrder(row, viewerId) {
  const listing = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(row.listing_id);
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(row.buyer_id);
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(row.seller_id);
  const tx = db.prepare('SELECT * FROM transactions WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(row.id);
  return {
    id: row.id,
    status: row.status,
    amountMinor: row.amount_minor,
    amount: row.amount_minor / 100,
    commissionMinor: row.commission_minor,
    commissionRate: row.status === 'held_founder_review' ? null : row.commission_rate,
    payoutMinor: row.payout_minor,
    currency: row.currency,
    provider: row.provider,
    providerRef: row.provider_ref,
    deliveryNote: row.delivery_note,
    // A held order has no authorised commission yet, so the UI must not show ₦0 as if it were a rate.
    commissionHeld: row.status === 'held_founder_review',
    reviewNote: row.review_note || '',
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    listing: listing ? { id: listing.id, title: listing.title, media: parseJSON(listing.media, [])[0] ? `/api/media/${parseJSON(listing.media, [])[0]}` : null } : null,
    buyer: toPublicUser(buyer, viewerId),
    seller: toPublicUser(seller, viewerId),
    role: row.buyer_id === viewerId ? 'buyer' : 'seller',
    transaction: tx ? { id: tx.id, status: tx.status, providerRef: tx.provider_ref, createdAt: tx.created_at } : null,
  };
}

router.post('/market/listings/:id/orders', requireAuth, rateLimit({ name: 'order', limit: 40, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const listing = db.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'active'").get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'not_found', message: 'Listing is not available.' });
  if (listing.seller_id === req.user.id) return badRequest(res, 'You cannot buy your own listing.');
  if (isBlocked(req.user.id, listing.seller_id)) return res.status(403).json({ error: 'blocked', message: 'This seller is not available to you.' });

  // Idempotency: a retried request (offline replay, double tap, network retry) returns the
  // original order instead of creating a second charge.
  const idempotencyKey = clean(req.get('Idempotency-Key') || req.body.clientId, 100);
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM orders WHERE buyer_id = ? AND idempotency_key = ?').get(req.user.id, idempotencyKey);
    if (existing) {
      return res.status(200).json({
        order: serializeOrder(existing, req.user.id),
        payment: { status: 'already_created', message: 'This order already exists. No second charge was created.' },
        idempotentReplay: true,
      });
    }
  }

  // The client can never dictate the amount, commission or payout: those come from the
  // listing row and the approved table. A conflicting client amount is rejected and audited.
  const claimedMinor = req.body.amountMinor !== undefined ? Number(req.body.amountMinor) : undefined;
  const claimedNaira = req.body.amount !== undefined ? Math.round(Number(req.body.amount) * 100) : undefined;
  const claimed = claimedMinor !== undefined ? claimedMinor : claimedNaira;
  if (claimed !== undefined && claimed !== listing.price_minor) {
    audit(req.user.id, 'order.tamper_rejected', 'listing', listing.id, { claimed, actual: listing.price_minor }, clientIp(req));
    return badRequest(res, 'The order amount must be the listing price.');
  }

  const pricing = resolveCommission(listing.price_minor);
  if (!pricing.valid) return badRequest(res, 'This listing price cannot be charged.');

  const id = uid('ord_');
  const ts = now();
  const status = pricing.held ? 'held_founder_review' : 'pending_payment';
  const commissionMinor = pricing.held ? 0 : pricing.commissionMinor;
  const rate = pricing.held ? 0 : pricing.rate;
  const payoutMinor = pricing.held ? 0 : pricing.payoutMinor;
  db.prepare(
    `INSERT INTO orders (id, listing_id, buyer_id, seller_id, amount_minor, commission_minor, commission_rate, payout_minor, currency, status, provider, delivery_note, idempotency_key, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'paystack',?,?,?,?)`
  ).run(id, listing.id, req.user.id, listing.seller_id, listing.price_minor, commissionMinor, rate, payoutMinor, listing.currency, status, clean(req.body.deliveryNote, 400), idempotencyKey || null, ts, ts);

  audit(req.user.id, pricing.held ? 'order.held_founder_review' : 'order.create', 'order', id, {
    listingId: listing.id, amountMinor: listing.price_minor, commissionMinor, rate, tier: pricing.tier, held: pricing.held,
  }, clientIp(req));
  notify(listing.seller_id, { type: pricing.held ? 'order_held' : 'order_created', actorId: req.user.id, entityType: 'order', entityId: id });

  const payment = pricing.held
    ? {
      status: 'held_founder_review',
      message: 'Orders above ₦10,000,000 are held for Founder review. No payment has been requested and nothing will be charged automatically.',
    }
    : await initializePayment({ orderId: id, email: req.user.email, amountMinor: listing.price_minor, req });

  res.status(201).json({
    order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id), req.user.id),
    payment,
  });
});

async function initializePayment({ orderId, email, amountMinor, req }) {
  // The amount always comes from the server-side order row, and held/rejected orders can
  // never reach the provider.
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { status: 'failed', message: 'Order not found.' };
  if (order.status !== 'pending_payment') {
    return { status: 'blocked', message: `This order is ${order.status.replace(/_/g, ' ')} and cannot be charged.` };
  }
  if (amountMinor !== order.amount_minor) {
    audit(order.buyer_id, 'order.amount_mismatch_blocked', 'order', orderId, { attempted: amountMinor, actual: order.amount_minor }, '');
    return { status: 'blocked', message: 'Order amount mismatch.' };
  }
  // All provider traffic goes through server/paystack.js so the configured mode, base URL
  // and live-key guard apply here exactly as they do everywhere else.
  const provider = paystack.paymentStatus();
  if (!provider.enabled) {
    return {
      status: provider.reason === 'not_configured' ? 'not_configured' : 'blocked',
      message: `${provider.message} The order stays pending payment.`,
    };
  }
  const reference = `ash_${orderId}_${crypto.randomBytes(6).toString('hex')}`;
  try {
    const result = await paystack.initializeTransaction({
      email,
      amountMinor,
      reference,
      callbackUrl: `${req.protocol}://${req.get('host')}/market?verify=${reference}`,
      metadata: { orderId, product: '#ash Mesh marketplace' },
    });
    if (!result.ok) {
      return { status: 'failed', message: result.message || 'Payment provider rejected the request.' };
    }
    db.prepare('UPDATE orders SET provider_ref = ?, updated_at = ? WHERE id = ?').run(reference, now(), orderId);
    db.prepare("INSERT INTO transactions (id, order_id, provider, provider_ref, amount_minor, commission_minor, status, raw, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(uid('txn_'), orderId, 'paystack', reference, amountMinor, commissionFor(amountMinor).commissionMinor, 'initialized', JSON.stringify(result.data || {}), now());
    return { status: 'initialized', authorizationUrl: result.data?.authorization_url, reference };
  } catch (err) {
    return { status: 'failed', message: err.message || 'Payment provider could not be reached.' };
  }
}

router.get('/market/orders', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE buyer_id = ? OR seller_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id, req.user.id);
  res.json({ orders: rows.map((r) => serializeOrder(r, req.user.id)) });
});

router.get('/market/orders/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Order not found.' });
  const isParticipant = row.buyer_id === req.user.id || row.seller_id === req.user.id;
  const canModerate = req.user.is_founder === 1 || parseJSON(req.user.permissions, []).includes('marketplace.view');
  if (!isParticipant && !canModerate) return res.status(403).json({ error: 'forbidden', message: 'You cannot view this order.' });
  res.json({ order: serializeOrder(row, req.user.id) });
});

router.post('/market/orders/:id/pay', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ? AND buyer_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Order not found.' });
  if (row.status !== 'pending_payment') return badRequest(res, 'This order is not awaiting payment.');
  const payment = await initializePayment({ orderId: row.id, email: req.user.email, amountMinor: row.amount_minor, req });
  res.json({ payment, order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id), req.user.id) });
});

// Provider verification. Payment is only ever marked paid after the provider confirms it.
router.get('/market/payments/verify', requireAuth, async (req, res) => {
  const reference = clean(req.query.reference, 120);
  const config = paystack.paymentStatus();
  if (!config.enabled) return res.status(503).json({ error: config.reason, message: config.message });
  if (!reference) return badRequest(res, 'A payment reference is required.');
  const tx = db.prepare('SELECT * FROM transactions WHERE provider_ref = ?').get(reference);
  if (!tx) return res.status(404).json({ error: 'not_found', message: 'Unknown payment reference.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(tx.order_id);
  if (!order || order.buyer_id !== req.user.id) return res.status(403).json({ error: 'forbidden', message: 'This payment is not yours.' });

  // The provider is the only source of truth for a payment; the client never is.
  const response = await paystack.verifyTransaction(reference);
  const data = { status: response.ok, data: response.data, message: response.message };
  // The provider must confirm the exact order amount; a short or mismatched payment is not accepted.
  const providerAmount = Number(data.data?.amount);
  const exactAmount = providerAmount === order.amount_minor;
  if (response.ok && data.status && data.data?.status === 'success' && !exactAmount) {
    audit(order.buyer_id, 'order.amount_mismatch_blocked', 'order', order.id, { providerAmount, orderAmount: order.amount_minor }, clientIp(req));
  }
  const paid = response.ok && data.status && data.data?.status === 'success' && exactAmount;
  if (paid) completeOrder(order.id, reference, data.data);
  res.json({
    verified: !!paid,
    providerStatus: data.data?.status || 'unknown',
    order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), req.user.id),
  });
});

function completeOrder(orderId, reference, raw) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  // Idempotent: a repeated provider callback for a settled order changes nothing.
  if (['paid', 'shipped', 'completed'].includes(order.status)) return order;
  // Held, rejected or cancelled orders are never completed automatically.
  if (order.status !== 'pending_payment') return null;

  const pricing = resolveCommission(order.amount_minor);
  if (!pricing.valid || pricing.held) {
    audit(order.buyer_id, 'order.commission_blocked', 'order', orderId, { amountMinor: order.amount_minor }, '');
    return null;
  }
  let commissionMinor = order.commission_minor;
  let rate = order.commission_rate;
  if (commissionMinor !== pricing.commissionMinor || rate !== pricing.rate) {
    // Stored figures are re-derived from the approved table, never trusted as-is.
    audit(order.buyer_id, 'order.commission_corrected', 'order', orderId, {
      from: { commissionMinor, rate }, to: { commissionMinor: pricing.commissionMinor, rate: pricing.rate },
    }, '');
    commissionMinor = pricing.commissionMinor;
    rate = pricing.rate;
  }

  db.prepare("UPDATE orders SET status = 'paid', commission_minor = ?, commission_rate = ?, payout_minor = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment'")
    .run(commissionMinor, rate, order.amount_minor - commissionMinor, now(), orderId);
  const updated = db.prepare("UPDATE transactions SET status = 'success', commission_minor = ?, raw = ? WHERE provider_ref = ?")
    .run(commissionMinor, JSON.stringify(raw || {}), reference);
  if (updated.changes === 0) {
    db.prepare("INSERT INTO transactions (id, order_id, provider, provider_ref, amount_minor, commission_minor, status, raw, created_at) VALUES (?,?,?,?,?,?, 'success', ?, ?)")
      .run(uid('txn_'), orderId, order.provider, reference, order.amount_minor, commissionMinor, JSON.stringify(raw || {}), now());
  }
  db.prepare("UPDATE marketplace_listings SET status = 'sold', updated_at = ? WHERE id = ?").run(now(), order.listing_id);
  notify(order.seller_id, { type: 'order_paid', actorId: order.buyer_id, entityType: 'order', entityId: orderId, data: { amount: order.amount_minor / 100 } });
  notify(order.buyer_id, { type: 'order_paid', actorId: order.seller_id, entityType: 'order', entityId: orderId });
  audit(order.buyer_id, 'order.paid', 'order', orderId, {
    reference, amountMinor: order.amount_minor, commissionMinor, commissionRate: rate, payoutMinor: order.amount_minor - commissionMinor,
  }, '');
  const settled = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  // Money becomes real only here: the seller share goes to the pending bucket and the
  // commission to the platform account. Both entries are idempotent per order.
  recordOrderPaid(settled);
  return settled;
}

// Paystack webhook — the signature is verified over the raw body before any state change,
// and each accepted event is recorded once so a replayed delivery cannot act twice.
router.post('/market/payments/webhook', express.json({ type: '*/*' }), (req, res) => {
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const check = paystack.verifyWebhookSignature(raw, req.get('x-paystack-signature'));
  if (!check.ok) {
    return res.status(check.reason === 'not_configured' ? 503 : 401).json({ error: check.reason });
  }
  const event = req.body || {};
  const eventType = clean(event.event, 60) || 'unknown';
  const payloadHash = crypto.createHash('sha256').update(raw).digest('hex');
  const eventKey = String(event.id || event.data?.id || payloadHash).slice(0, 120);
  const claim = db
    .prepare(
      'INSERT OR IGNORE INTO payment_events (id, provider, event_key, event_type, reference, payload_hash, received_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(uid('evt_'), 'paystack', eventKey, eventType, String(event.data?.reference || '').slice(0, 120), payloadHash, now());
  if (claim.changes === 0) return res.json({ ok: true, duplicate: true });

  let outcome = 'ignored';
  if (eventType === 'charge.success') {
    const reference = String(event.data?.reference || '');
    const order = db.prepare('SELECT * FROM orders WHERE provider_ref = ?').get(reference);
    if (order && Number(event.data?.amount) >= order.amount_minor) {
      outcome = completeOrder(order.id, reference, event.data) ? 'order_paid' : 'order_not_completed';
    } else if (order) {
      audit(order.buyer_id, 'order.webhook_amount_mismatch', 'order', order.id, {
        providerAmount: Number(event.data?.amount), orderAmount: order.amount_minor,
      }, '');
      outcome = 'amount_mismatch';
    } else {
      outcome = 'unknown_reference';
    }
  } else if (eventType === 'refund.processed') {
    const txRef = String(event.data?.transaction_reference || event.data?.transaction?.reference || '');
    const refundRef = String(event.data?.reference || event.data?.id || '');
    const refundRow =
      (txRef &&
        db
          .prepare("SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.provider_ref = ? AND r.status = 'processing' ORDER BY r.created_at DESC LIMIT 1")
          .get(txRef)) ||
      (refundRef && db.prepare("SELECT * FROM refunds WHERE provider_ref = ? AND status = 'processing' LIMIT 1").get(refundRef)) ||
      null;
    outcome = refundRow && completeRefund({ refundId: refundRow.id, providerData: event.data }) ? 'refund_completed' : 'refund_not_matched';
  } else if (eventType.startsWith('transfer.')) {
    const reference = String(event.data?.reference || '');
    const payout = db.prepare('SELECT * FROM payout_requests WHERE provider_ref = ?').get(reference);
    if (!payout) {
      outcome = 'payout_not_matched';
    } else {
      const settled = settlePayout({
        payoutId: payout.id,
        outcome: eventType === 'transfer.success' ? 'paid' : 'failed',
        providerData: event.data,
        reason: String(event.data?.reason || eventType),
      });
      outcome = settled ? `payout_${settled.status}` : 'payout_not_processing';
    }
  }
  db.prepare('UPDATE payment_events SET outcome = ? WHERE event_key = ?').run(outcome, eventKey);
  res.json({ ok: true, outcome });
});

router.post('/market/orders/:id/status', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Order not found.' });
  const status = clean(req.body.status, 20);
  // A refund is never a bare status flip: the provider must confirm it, so refunds go
  // through POST /api/wallet/orders/:id/refund which reverses the ledger on confirmation.
  if (status === 'refunded') {
    return res.status(409).json({
      error: 'use_refund_endpoint',
      message: 'Refunds must go through the refund endpoint so the payment provider confirms the reversal before any balance changes.',
    });
  }
  const transitions = {
    shipped: { from: ['paid'], role: 'seller' },
    completed: { from: ['shipped', 'paid'], role: 'buyer' },
    cancelled: { from: ['pending_payment'], role: 'buyer' },
  };
  const rule = transitions[status];
  if (!rule) return badRequest(res, 'Unknown order status.');
  if (!rule.from.includes(row.status)) return badRequest(res, `Cannot move a ${row.status} order to ${status}.`);
  const isBuyer = row.buyer_id === req.user.id;
  const isSeller = row.seller_id === req.user.id;
  const isAdmin = req.user.is_founder === 1 || parseJSON(req.user.permissions, []).includes('marketplace.manage');
  const allowed = (rule.role === 'buyer' && isBuyer) || (rule.role === 'seller' && isSeller) || (rule.role === 'founder_or_admin' && isAdmin);
  if (!allowed) return res.status(403).json({ error: 'forbidden', message: 'You cannot perform this action on the order.' });
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), row.id);
  // Buyer confirmation moves the seller's pending share into the withdrawable balance.
  if (status === 'completed') releaseOrderFunds(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id));
  notify(isBuyer ? row.seller_id : row.buyer_id, { type: `order_${status}`, actorId: req.user.id, entityType: 'order', entityId: row.id });
  audit(req.user.id, `order.${status}`, 'order', row.id, {}, clientIp(req));
  res.json({ order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id), req.user.id) });
});

/* --------------------- Founder review of held orders ----------------------
   Orders above ₦10,000,000 have no authorised commission rate, so they are created as
   held_founder_review. Only the Founder can release or reject one, and nothing is ever
   charged, refunded or released automatically.
-------------------------------------------------------------------------- */

router.get('/market/held-orders', requireAuth, (req, res) => {
  if (req.user.is_founder !== 1) return res.status(403).json({ error: 'forbidden', message: 'Founder authority is required.' });
  const rows = db.prepare("SELECT * FROM orders WHERE status = 'held_founder_review' ORDER BY created_at DESC").all();
  res.json({ orders: rows.map((r) => serializeOrder(r, req.user.id)) });
});

router.post('/market/orders/:id/review', requireAuth, rateLimit({ name: 'order-review', limit: 60, windowMs: 60 * 60 * 1000 }), (req, res) => {
  if (req.user.is_founder !== 1) return res.status(403).json({ error: 'forbidden', message: 'Only the Founder can review held orders.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found', message: 'Order not found.' });
  if (order.status !== 'held_founder_review') return badRequest(res, 'Only orders held for Founder review can be reviewed.');
  const decision = clean(req.body.decision, 20);
  const note = clean(req.body.note, 500);
  if (decision !== 'approve' && decision !== 'reject') return badRequest(res, 'Decision must be approve or reject.');
  if (decision === 'approve' && !note) return badRequest(res, 'Record the agreed commission or reason before releasing this order.');
  const next = decision === 'approve' ? 'pending_payment' : 'rejected';
  db.prepare("UPDATE orders SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'held_founder_review'")
    .run(next, note, req.user.id, now(), now(), order.id);
  audit(req.user.id, decision === 'approve' ? 'order.review_approved' : 'order.review_rejected', 'order', order.id, { amountMinor: order.amount_minor, note }, clientIp(req));
  notify(order.buyer_id, { type: `order_${next}`, actorId: req.user.id, entityType: 'order', entityId: order.id });
  notify(order.seller_id, { type: `order_${next}`, actorId: req.user.id, entityType: 'order', entityId: order.id });
  res.json({ order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), req.user.id) });
});

/* --------------------------- seller verification -------------------------- */

router.post('/market/verification', requireAuth, rateLimit({ name: 'verify', limit: 5, windowMs: 24 * 60 * 60 * 1000 }), upload.single('document'), (req, res) => {
  const businessName = clean(req.body.businessName, 160);
  const idType = clean(req.body.idType, 40);
  const idNumber = clean(req.body.idNumber, 80);
  if (!businessName || !idType || !idNumber) return badRequest(res, 'Business name, ID type and ID number are required.');
  if (!req.file) return badRequest(res, 'Attach a supporting document.');
  const pending = db.prepare("SELECT 1 FROM seller_verifications WHERE user_id = ? AND status = 'pending'").get(req.user.id);
  if (pending) return res.status(409).json({ error: 'already_pending', message: 'You already have a verification under review.' });
  let media;
  try {
    media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'file' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'upload_failed', message: err.message });
  }
  const id = uid('vrf_');
  db.prepare('INSERT INTO seller_verifications (id, user_id, business_name, id_type, id_number, doc_media_id, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, businessName, idType, idNumber, media.id, 'pending', now());
  audit(req.user.id, 'verification.submit', 'verification', id, {}, clientIp(req));
  res.status(201).json({ ok: true, id, status: 'pending' });
});

router.get('/market/verification/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, business_name, id_type, status, review_note, created_at, reviewed_at FROM seller_verifications WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const user = db.prepare('SELECT is_verified_seller FROM users WHERE id = ?').get(req.user.id);
  res.json({ verifications: rows, isVerifiedSeller: !!user.is_verified_seller });
});

/* ------------------------------ fraud reports ----------------------------- */

router.post('/market/fraud-report', requireAuth, rateLimit({ name: 'fraud', limit: 20, windowMs: 24 * 60 * 60 * 1000 }), (req, res) => {
  const listingId = clean(req.body.listingId, 60);
  const orderId = clean(req.body.orderId, 60);
  const details = clean(req.body.details, 2000);
  const reason = clean(req.body.reason, 120) || 'suspected_fraud';
  if (!details) return badRequest(res, 'Describe what happened.');
  let targetType = 'listing';
  let targetId = listingId;
  if (orderId) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)) {
      return res.status(403).json({ error: 'forbidden', message: 'You cannot report this order.' });
    }
    targetType = 'order';
    targetId = orderId;
  } else {
    const listing = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(listingId);
    if (!listing) return res.status(404).json({ error: 'not_found', message: 'Listing not found.' });
  }
  const id = uid('rpt_');
  db.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, targetType, targetId, `marketplace:${reason}`, details, 'open', now());
  audit(req.user.id, 'marketplace.fraud_report', targetType, targetId, { reason }, clientIp(req));
  res.status(201).json({ ok: true, id, message: 'Fraud report submitted for investigation.' });
});

export default router;
