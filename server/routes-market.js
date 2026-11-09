// #ash Mesh — marketplace: listings, orders, commission, payments, seller verification.
import crypto from 'node:crypto';
import express from 'express';
import { db, uid, now, parseJSON, toPublicUser, notify, audit, areFriends, isBlocked } from '../db.js';
import { requireAuth, upload, saveMedia, rateLimit, clean, clampInt, badRequest, clientIp } from '../lib.js';

const router = express.Router();

/* ------------------------- approved commission table ----------------------
   ₦1–₦100,000           3%
   ₦100,001–₦500,000     5%
   ₦500,001–₦1,000,000   3%
   ₦1,000,001–₦5,000,000 2.5%
   ₦5,000,001–₦10,000,000 2%
   Amounts above ₦10,000,000 keep the highest defined tier (2%) because no
   higher band was authorised. Rates must not be changed without authorisation.
-------------------------------------------------------------------------- */
export const COMMISSION_TIERS = [
  { min: 1, max: 100000, rate: 0.03 },
  { min: 100001, max: 500000, rate: 0.05 },
  { min: 500001, max: 1000000, rate: 0.03 },
  { min: 1000001, max: 5000000, rate: 0.025 },
  { min: 5000001, max: 10000000, rate: 0.02 },
];

export function commissionRate(amountNaira) {
  if (!Number.isFinite(amountNaira) || amountNaira < 1) return 0;
  const tier = COMMISSION_TIERS.find((t) => amountNaira >= t.min && amountNaira <= t.max);
  if (tier) return tier.rate;
  return COMMISSION_TIERS[COMMISSION_TIERS.length - 1].rate;
}

/** Commission in minor units (kobo), rounded to the nearest kobo. */
export function commissionFor(amountMinor) {
  const naira = amountMinor / 100;
  const rate = commissionRate(naira);
  const commission = Math.round(amountMinor * rate);
  return { rate, commissionMinor: commission, payoutMinor: amountMinor - commission };
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
    commissionRate: row.commission_rate,
    payoutMinor: row.payout_minor,
    currency: row.currency,
    provider: row.provider,
    providerRef: row.provider_ref,
    deliveryNote: row.delivery_note,
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

  const { rate, commissionMinor, payoutMinor } = commissionFor(listing.price_minor);
  const id = uid('ord_');
  const ts = now();
  db.prepare(
    `INSERT INTO orders (id, listing_id, buyer_id, seller_id, amount_minor, commission_minor, commission_rate, payout_minor, currency, status, provider, delivery_note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'pending_payment','paystack',?,?,?)`
  ).run(id, listing.id, req.user.id, listing.seller_id, listing.price_minor, commissionMinor, rate, payoutMinor, listing.currency, clean(req.body.deliveryNote, 400), ts, ts);
  audit(req.user.id, 'order.create', 'order', id, { listingId: listing.id, amountMinor: listing.price_minor }, clientIp(req));
  notify(listing.seller_id, { type: 'order_created', actorId: req.user.id, entityType: 'order', entityId: id });

  const payment = await initializePayment({ orderId: id, email: req.user.email, amountMinor: listing.price_minor, req });
  res.status(201).json({
    order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id), req.user.id),
    payment,
  });
});

async function initializePayment({ orderId, email, amountMinor, req }) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return {
      status: 'not_configured',
      message: 'Online payment is not configured on this deployment. The order is recorded as pending payment; set PAYSTACK_SECRET_KEY to enable real card/bank payment.',
    };
  }
  const reference = `ash_${orderId}_${crypto.randomBytes(6).toString('hex')}`;
  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: amountMinor,
        currency: 'NGN',
        reference,
        callback_url: `${req.protocol}://${req.get('host')}/market?verify=${reference}`,
        metadata: { orderId, product: '#ash Mesh marketplace' },
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.status) {
      return { status: 'failed', message: data.message || 'Payment provider rejected the request.' };
    }
    db.prepare('UPDATE orders SET provider_ref = ?, updated_at = ? WHERE id = ?').run(reference, now(), orderId);
    db.prepare("INSERT INTO transactions (id, order_id, provider, provider_ref, amount_minor, commission_minor, status, raw, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(uid('txn_'), orderId, 'paystack', reference, amountMinor, commissionFor(amountMinor).commissionMinor, 'initialized', JSON.stringify(data.data || {}), now());
    return { status: 'initialized', authorizationUrl: data.data?.authorization_url, reference };
  } catch (err) {
    return { status: 'failed', message: `Payment provider unreachable: ${err.message}` };
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
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'payment_not_configured', message: 'Payment provider is not configured on this deployment.' });
  if (!reference) return badRequest(res, 'A payment reference is required.');
  const tx = db.prepare('SELECT * FROM transactions WHERE provider_ref = ?').get(reference);
  if (!tx) return res.status(404).json({ error: 'not_found', message: 'Unknown payment reference.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(tx.order_id);
  if (!order || order.buyer_id !== req.user.id) return res.status(403).json({ error: 'forbidden', message: 'This payment is not yours.' });

  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = await response.json();
  const paid = response.ok && data.status && data.data?.status === 'success' && Number(data.data.amount) >= order.amount_minor;
  if (paid) completeOrder(order.id, reference, data.data);
  res.json({
    verified: !!paid,
    providerStatus: data.data?.status || 'unknown',
    order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), req.user.id),
  });
});

function completeOrder(orderId, reference, raw) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'pending_payment') return;
  db.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), orderId);
  db.prepare("UPDATE transactions SET status = 'success', raw = ? WHERE provider_ref = ?").run(JSON.stringify(raw || {}), reference);
  db.prepare("UPDATE marketplace_listings SET status = 'sold', updated_at = ? WHERE id = ?").run(now(), order.listing_id);
  notify(order.seller_id, { type: 'order_paid', actorId: order.buyer_id, entityType: 'order', entityId: orderId, data: { amount: order.amount_minor / 100 } });
  notify(order.buyer_id, { type: 'order_paid', actorId: order.seller_id, entityType: 'order', entityId: orderId });
  audit(order.buyer_id, 'order.paid', 'order', orderId, { reference, commissionMinor: order.commission_minor }, '');
}

// Paystack webhook — signature verified with the secret key before any state change.
router.post('/market/payments/webhook', express.json({ type: '*/*' }), (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'payment_not_configured' });
  const signature = req.get('x-paystack-signature') || '';
  const raw = req.rawBody || JSON.stringify(req.body);
  const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  const event = req.body;
  if (event?.event === 'charge.success') {
    const reference = event.data?.reference;
    const order = db.prepare('SELECT * FROM orders WHERE provider_ref = ?').get(reference);
    if (order && Number(event.data.amount) >= order.amount_minor) completeOrder(order.id, reference, event.data);
  }
  res.json({ ok: true });
});

router.post('/market/orders/:id/status', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Order not found.' });
  const status = clean(req.body.status, 20);
  const transitions = {
    shipped: { from: ['paid'], role: 'seller' },
    completed: { from: ['shipped', 'paid'], role: 'buyer' },
    cancelled: { from: ['pending_payment'], role: 'buyer' },
    refunded: { from: ['paid', 'shipped', 'completed'], role: 'founder_or_admin' },
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
  if (status === 'refunded') {
    db.prepare("INSERT INTO transactions (id, order_id, provider, provider_ref, amount_minor, commission_minor, status, created_at) VALUES (?,?,?,?,?,?, 'refunded', ?)")
      .run(uid('txn_'), row.id, row.provider, row.provider_ref || '', row.amount_minor, row.commission_minor, now());
  }
  notify(isBuyer ? row.seller_id : row.buyer_id, { type: `order_${status}`, actorId: req.user.id, entityType: 'order', entityId: row.id });
  audit(req.user.id, `order.${status}`, 'order', row.id, {}, clientIp(req));
  res.json({ order: serializeOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id), req.user.id) });
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
