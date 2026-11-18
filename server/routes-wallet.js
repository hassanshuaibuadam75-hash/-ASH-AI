// #ash Mesh — Stage D wallet API.
//
// Every balance shown here is derived from the immutable ledger in server/wallet.js.
// A client can request a payout or a refund, but only the server decides whether the
// money moves, and a provider confirmation is required before anything is settled.
import express from 'express';
import { requireAuth, requireFounder, rateLimit, clean, clientIp } from './lib.js';
import * as paystack from './paystack.js';
import {
  walletSummary,
  saveBankAccount,
  publicBankAccount,
  requestPayout,
  cancelPayout,
  reviewPayout,
  processPayout,
  founderWalletOverview,
  refundOrder,
  refundsForOrder,
  serializeRefund,
  getPayout,
  serializePayout,
  payoutsForSeller,
} from './wallet.js';

const router = express.Router();

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    const status = Number(err.status) || 500;
    if (status >= 500) console.error('[wallet]', err.error || 'error', err.message);
    res.status(status).json({
      error: err.error || 'wallet_error',
      message: status >= 500 ? 'The wallet operation could not be completed.' : err.message,
    });
  }
};

/* --------------------------------- overview ------------------------------ */

router.get(
  '/wallet',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ wallet: walletSummary(req.user.id), banks: await bankOptions() });
  })
);

// Bank list for the seller form. Comes from the provider when it is configured; no
// invented bank codes are ever presented as real.
async function bankOptions() {
  const config = paystack.paymentStatus();
  if (!config.enabled) {
    return { configured: false, list: [], message: 'Bank verification needs the payment provider to be configured.' };
  }
  const result = await paystack.listBanks();
  if (!result.ok) return { configured: true, list: [], message: `Bank list unavailable: ${result.message}` };
  const list = (Array.isArray(result.data) ? result.data : [])
    .map((b) => ({ name: String(b.name || ''), code: String(b.code || '') }))
    .filter((b) => b.name && b.code)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { configured: true, list, message: null };
}

router.get('/wallet/banks', requireAuth, wrap(async (_req, res) => {
  res.json({ banks: await bankOptions(), paymentConfig: paystack.paymentStatus() });
}));

/* ------------------------------- bank details ---------------------------- */

router.post(
  '/wallet/bank-account',
  requireAuth,
  rateLimit({ name: 'bank-account', limit: 10, windowMs: 60 * 60 * 1000 }),
  wrap(async (req, res) => {
    const account = await saveBankAccount({
      userId: req.user.id,
      bankCode: clean(req.body.bankCode, 20),
      bankName: clean(req.body.bankName, 120),
      accountNumber: clean(req.body.accountNumber, 20).replace(/\s+/g, ''),
      accountName: clean(req.body.accountName, 120),
      ip: clientIp(req),
    });
    res.json({ bankAccount: account, paymentConfig: paystack.paymentStatus() });
  })
);

router.get('/wallet/bank-account', requireAuth, wrap(async (req, res) => {
  res.json({ bankAccount: publicBankAccount(req.user.id), paymentConfig: paystack.paymentStatus() });
}));

/* --------------------------------- payouts ------------------------------- */

router.post(
  '/wallet/payouts',
  requireAuth,
  rateLimit({ name: 'payout-request', limit: 10, windowMs: 60 * 60 * 1000 }),
  wrap(async (req, res) => {
    const result = requestPayout({
      userId: req.user.id,
      amountMinor: Number(req.body.amountMinor),
      note: clean(req.body.note, 300),
      idempotencyKey: clean(req.body.idempotencyKey || req.get('idempotency-key'), 100),
      ip: clientIp(req),
    });
    res.status(result.duplicate ? 200 : 201).json({ payout: result.payout, duplicate: result.duplicate, wallet: walletSummary(req.user.id) });
  })
);

router.get('/wallet/payouts', requireAuth, wrap(async (req, res) => {
  res.json({ payouts: payoutsForSeller(req.user.id).map(serializePayout) });
}));

router.post('/wallet/payouts/:id/cancel', requireAuth, wrap(async (req, res) => {
  const payout = getPayout(req.params.id);
  if (!payout) return res.status(404).json({ error: 'not_found', message: 'Payout not found.' });
  const isOwner = payout.seller_id === req.user.id;
  const isFounder = req.user.is_founder === 1;
  if (!isOwner && !isFounder) return res.status(403).json({ error: 'forbidden', message: 'This payout is not yours.' });
  const updated = cancelPayout({ payoutId: payout.id, userId: isOwner ? req.user.id : null, actorId: req.user.id, ip: clientIp(req) });
  res.json({ payout: updated, wallet: isOwner ? walletSummary(req.user.id) : undefined });
}));

/* ------------------------- Founder payout controls ----------------------- */

router.get('/wallet/founder', requireAuth, requireFounder, wrap(async (_req, res) => {
  res.json({ overview: founderWalletOverview() });
}));

router.post(
  '/wallet/payouts/:id/review',
  requireAuth,
  requireFounder,
  rateLimit({ name: 'payout-review', limit: 60, windowMs: 60 * 60 * 1000 }),
  wrap(async (req, res) => {
    const payout = reviewPayout({
      payoutId: req.params.id,
      actorId: req.user.id,
      decision: clean(req.body.decision, 20),
      note: clean(req.body.note, 300),
      ip: clientIp(req),
    });
    res.json({ payout });
  })
);

router.post('/wallet/payouts/:id/process', requireAuth, requireFounder, wrap(async (req, res) => {
  const result = await processPayout({ payoutId: req.params.id, actorId: req.user.id, ip: clientIp(req) });
  res.json(result);
}));

/* --------------------------------- refunds ------------------------------- */

router.post(
  '/wallet/orders/:id/refund',
  requireAuth,
  rateLimit({ name: 'refund', limit: 20, windowMs: 60 * 60 * 1000 }),
  wrap(async (req, res) => {
    const order = req.app.locals.dbOrder ? req.app.locals.dbOrder(req.params.id) : null;
    void order;
    const result = await refundOrder({
      orderId: req.params.id,
      actorId: req.user.id,
      amountMinor: req.body.amountMinor === undefined ? undefined : Number(req.body.amountMinor),
      reason: clean(req.body.reason, 300),
      ip: clientIp(req),
    });
    res.json(result);
  })
);

router.get('/wallet/orders/:id/refunds', requireAuth, wrap(async (req, res) => {
  res.json({ refunds: refundsForOrder(req.params.id).map(serializeRefund) });
}));

export default router;
