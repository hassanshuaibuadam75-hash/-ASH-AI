// #ash Mesh — wallet, immutable ledger, seller bank details, payouts and refunds.
//
// Money rules enforced here (all server-side):
//   * balances are DERIVED from wallet_ledger; no row ever stores an editable balance
//   * ledger rows are append-only and carry a unique idempotency key, so a retried
//     webhook or a double-tapped request can never credit or debit twice
//   * a debit that would make a user balance negative is refused
//   * a payout is only marked paid after the provider confirms the transfer
//   * a refund is only settled after the provider confirms it, and it reverses the
//     seller's share and the platform commission on the same order
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, uid, now, audit, notify, parseJSON, DATA_DIR } from './db.js';
import * as paystack from './paystack.js';

export const PAYOUT_MIN_MINOR = 10000; // ₦100
export const PAYOUT_STATES = ['pending', 'under_review', 'approved', 'processing', 'paid', 'failed', 'cancelled'];
const OPEN_PAYOUT_STATES = ['pending', 'under_review', 'approved', 'processing'];

export function httpError(status, error, message) {
  const err = new Error(message);
  err.status = status;
  err.error = error;
  return err;
}

/* ------------------------------ bank detail keys --------------------------
   Account numbers are encrypted at rest with AES-256-GCM. The key comes from
   BANK_DETAILS_KEY when the operator provides one; otherwise a random key is created
   inside the private data directory (mode 0600) so the number is never stored in
   clear text. The key is never sent to a client or written to logs.
------------------------------------------------------------------------- */
const SECRET_DIR = path.join(DATA_DIR, 'secrets');
let cachedKey = null;

function bankKey() {
  if (cachedKey) return cachedKey;
  const configured = String(process.env.BANK_DETAILS_KEY || '').trim();
  if (configured) {
    const buf = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
    if (buf.length !== 32) throw httpError(500, 'bank_key_invalid', 'BANK_DETAILS_KEY must be 32 bytes (hex or base64).');
    cachedKey = buf;
    return cachedKey;
  }
  const file = path.join(SECRET_DIR, 'bank.key');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === 32) {
      cachedKey = existing;
      return cachedKey;
    }
  } catch { /* first run */ }
  fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(file, generated, { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

export function encryptAccountNumber(accountNumber) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', bankKey(), iv);
  const body = Buffer.concat([cipher.update(String(accountNumber), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`;
}

/** Internal only: used to build a provider recipient. Never returned by an API. */
export function decryptAccountNumber(payload) {
  const [version, ivB64, tagB64, bodyB64] = String(payload || '').split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !bodyB64) throw httpError(500, 'bank_record_invalid', 'Stored bank details could not be read.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', bankKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
}

const last4 = (value) => String(value || '').slice(-4);
const normalizeName = (value) => String(value || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/* --------------------------------- ledger -------------------------------- */

export function balance(userId, bucket = 'available', currency = 'NGN') {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS n
       FROM wallet_ledger WHERE account = 'user' AND user_id = ? AND bucket = ? AND currency = ?`
    )
    .get(userId, bucket, currency);
  return row?.n || 0;
}

export function platformBalance(bucket = 'available', currency = 'NGN') {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS n
       FROM wallet_ledger WHERE account = 'platform' AND bucket = ? AND currency = ?`
    )
    .get(bucket, currency);
  return row?.n || 0;
}

/**
 * Append one ledger entry. `idempotencyKey` is mandatory: the second call with the
 * same key returns the original row and changes nothing.
 */
export function postLedger({
  userId = null,
  account = 'user',
  bucket,
  direction,
  amountMinor,
  reason,
  refType = '',
  refId = '',
  idempotencyKey,
  meta = {},
  currency = 'NGN',
}) {
  if (!['available', 'pending'].includes(bucket)) throw httpError(500, 'ledger_invalid_bucket', 'Invalid ledger bucket.');
  if (!['credit', 'debit'].includes(direction)) throw httpError(500, 'ledger_invalid_direction', 'Invalid ledger direction.');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw httpError(500, 'ledger_invalid_amount', 'Ledger amount must be a positive integer in kobo.');
  if (!idempotencyKey) throw httpError(500, 'ledger_missing_key', 'A ledger entry requires an idempotency key.');
  if (account === 'user' && !userId) throw httpError(500, 'ledger_missing_user', 'A user ledger entry requires a user.');

  const write = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM wallet_ledger WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return { entry: existing, duplicate: true };
    if (account === 'user' && direction === 'debit') {
      const available = balance(userId, bucket, currency);
      if (available < amountMinor) {
        throw httpError(409, 'insufficient_balance', `Not enough ${bucket} balance for this operation.`);
      }
    }
    const id = uid('led_');
    db.prepare(
      `INSERT INTO wallet_ledger (id, user_id, account, bucket, direction, amount_minor, currency, reason, ref_type, ref_id, idempotency_key, meta, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, userId, account, bucket, direction, amountMinor, currency, reason, refType, refId, idempotencyKey, JSON.stringify(meta || {}), now());
    return { entry: db.prepare('SELECT * FROM wallet_ledger WHERE id = ?').get(id), duplicate: false };
  });
  return write();
}

const LEDGER_LABELS = {
  order_sale: 'Sale (held for release)',
  order_release_out: 'Released from pending',
  order_release_in: 'Sale available',
  commission: 'Platform commission',
  commission_reversal: 'Commission reversed',
  refund_out_pending: 'Refund from pending balance',
  refund_out_available: 'Refund from available balance',
  payout_hold: 'Payout requested',
  payout_reversal: 'Payout returned',
};

function serializeLedger(row) {
  return {
    id: row.id,
    bucket: row.bucket,
    direction: row.direction,
    amountMinor: row.amount_minor,
    amount: row.amount_minor / 100,
    currency: row.currency,
    reason: row.reason,
    label: LEDGER_LABELS[row.reason] || row.reason.replace(/_/g, ' '),
    refType: row.ref_type,
    refId: row.ref_id,
    createdAt: row.created_at,
  };
}

/* ------------------------------- bank account ---------------------------- */

export function publicBankAccount(userId) {
  const row = db
    .prepare('SELECT * FROM seller_bank_accounts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId);
  if (!row) return null;
  return {
    id: row.id,
    bankName: row.bank_name,
    bankCode: row.bank_code,
    accountLast4: row.account_last4,
    maskedAccountNumber: `••••••${row.account_last4}`,
    accountName: row.account_name,
    status: row.status,
    verificationNote: row.verification_note,
    updatedAt: row.updated_at,
  };
}

export function bankRecord(userId) {
  return db.prepare('SELECT * FROM seller_bank_accounts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
}

/**
 * Store bank details server-side. Changing them always resets verification, so a
 * seller cannot redirect an existing payout to a new account silently.
 */
export async function saveBankAccount({ userId, bankCode, bankName, accountNumber, accountName, ip = '' }) {
  if (!/^[0-9]{10}$/.test(String(accountNumber || ''))) {
    throw httpError(400, 'invalid_account_number', 'Enter a valid 10-digit Nigerian bank account number.');
  }
  if (!String(bankCode || '').trim() || !String(bankName || '').trim()) {
    throw httpError(400, 'invalid_bank', 'Select your bank.');
  }
  const config = paystack.paymentStatus();
  let resolvedName = '';
  let status = 'unverified';
  let note = 'Saved without provider verification. Payouts stay blocked until the account is verified.';

  if (config.enabled) {
    const resolved = await paystack.resolveAccountNumber({ accountNumber, bankCode });
    if (resolved.ok && resolved.data?.account_name) {
      resolvedName = String(resolved.data.account_name);
      const submitted = normalizeName(accountName);
      if (submitted && submitted !== normalizeName(resolvedName)) {
        status = 'name_mismatch';
        note = `The provider resolved this account to "${resolvedName}", which does not match the name you entered. Correct the account name to enable payouts.`;
      } else {
        status = 'verified';
        note = 'Account verified with the payment provider.';
      }
    } else {
      note = `The payment provider could not verify this account: ${resolved.message}`;
    }
  }

  const id = uid('bnk_');
  const ts = now();
  db.prepare(
    `INSERT INTO seller_bank_accounts (id, user_id, bank_code, bank_name, account_number_enc, account_last4, account_name, resolved_account_name, status, verification_note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, userId, String(bankCode).trim(), String(bankName).trim(), encryptAccountNumber(String(accountNumber)),
    last4(accountNumber), String(accountName || resolvedName || '').trim().slice(0, 120), resolvedName, status, note, ts, ts
  );
  audit(userId, 'wallet.bank_account_saved', 'bank_account', id, { bankCode, last4: last4(accountNumber), status }, ip);
  return publicBankAccount(userId);
}

/* --------------------------------- payouts ------------------------------- */

export function serializePayout(row) {
  const bank = row.bank_account_id
    ? db.prepare('SELECT * FROM seller_bank_accounts WHERE id = ?').get(row.bank_account_id)
    : null;
  const seller = db.prepare('SELECT id, username, full_name, is_verified_seller FROM users WHERE id = ?').get(row.seller_id);
  return {
    id: row.id,
    sellerId: row.seller_id,
    seller: seller ? { id: seller.id, username: seller.username, fullName: seller.full_name, isVerifiedSeller: !!seller.is_verified_seller } : null,
    amountMinor: row.amount_minor,
    amount: row.amount_minor / 100,
    currency: row.currency,
    status: row.status,
    note: row.note,
    failureReason: row.failure_reason,
    bank: bank
      ? { bankName: bank.bank_name, accountName: bank.account_name, accountLast4: bank.account_last4, status: bank.status }
      : null,
    provider: row.provider,
    providerRef: row.provider_ref,
    transferCode: row.transfer_code,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    processedAt: row.processed_at,
    updatedAt: row.updated_at,
    canCancel: ['pending', 'under_review', 'approved'].includes(row.status),
  };
}

export function getPayout(payoutId) {
  return db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(payoutId);
}

export function payoutQueue() {
  return db
    .prepare(`SELECT * FROM payout_requests WHERE status IN (${OPEN_PAYOUT_STATES.map(() => '?').join(',')}) ORDER BY requested_at ASC`)
    .all(...OPEN_PAYOUT_STATES);
}

export function payoutsForSeller(sellerId, limit = 50) {
  return db.prepare('SELECT * FROM payout_requests WHERE seller_id = ? ORDER BY requested_at DESC LIMIT ?').all(sellerId, limit);
}

export function requestPayout({ userId, amountMinor, note = '', idempotencyKey, ip = '' }) {
  const amount = Number(amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) throw httpError(400, 'invalid_amount', 'Enter the amount you want to withdraw.');
  if (amount < PAYOUT_MIN_MINOR) throw httpError(400, 'amount_too_small', `The minimum payout is ₦${PAYOUT_MIN_MINOR / 100}.`);

  const bank = bankRecord(userId);
  if (!bank) throw httpError(409, 'bank_account_required', 'Add your bank account before requesting a payout.');
  if (bank.status !== 'verified') {
    throw httpError(409, 'bank_account_unverified', 'Your bank account is not verified yet. Payouts stay blocked until verification succeeds.');
  }

  const key = String(idempotencyKey || '').trim().slice(0, 100) || null;
  if (key) {
    const existing = db.prepare('SELECT * FROM payout_requests WHERE seller_id = ? AND idempotency_key = ?').get(userId, key);
    if (existing) return { payout: serializePayout(existing), duplicate: true };
  }

  const available = balance(userId, 'available');
  if (amount > available) {
    throw httpError(409, 'insufficient_balance', 'Your available balance is lower than the requested payout.');
  }

  const id = uid('pay_');
  const ts = now();
  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO payout_requests (id, seller_id, amount_minor, currency, status, bank_account_id, provider, note, requested_at, updated_at, idempotency_key)
       VALUES (?,?,?,?, 'pending', ?, 'paystack', ?, ?, ?, ?)`
    ).run(id, userId, amount, 'NGN', bank.id, String(note || '').slice(0, 300), ts, ts, key);
    // The funds leave the available balance immediately and are held against this payout.
    postLedger({
      userId, bucket: 'available', direction: 'debit', amountMinor: amount, reason: 'payout_hold',
      refType: 'payout', refId: id, idempotencyKey: `payout:${id}:hold`, meta: { requestedBy: userId },
    });
  });
  create();

  audit(userId, 'payout.request', 'payout', id, { amountMinor: amount, bankAccountId: bank.id }, ip);
  notifyFounder({ type: 'payout_requested', actorId: userId, entityType: 'payout', entityId: id, data: { amount: amount / 100 } });
  return { payout: serializePayout(getPayout(id)), duplicate: false };
}

function notifyFounder({ type, actorId, entityType, entityId, data = {} }) {
  const founder = db.prepare("SELECT id FROM users WHERE is_founder = 1 AND role = 'founder' LIMIT 1").get();
  if (founder) notify(founder.id, { type, actorId, entityType, entityId, data });
}

function releasePayoutHold(payout, reason, ip = '') {
  postLedger({
    userId: payout.seller_id, bucket: 'available', direction: 'credit', amountMinor: payout.amount_minor,
    reason: 'payout_reversal', refType: 'payout', refId: payout.id,
    idempotencyKey: `payout:${payout.id}:release`, meta: { reason },
  });
  audit(payout.seller_id, 'payout.funds_released', 'payout', payout.id, { amountMinor: payout.amount_minor, reason }, ip);
}

export function cancelPayout({ payoutId, userId, actorId, ip = '' }) {
  const payout = getPayout(payoutId);
  if (!payout) throw httpError(404, 'not_found', 'Payout not found.');
  if (userId && payout.seller_id !== userId) throw httpError(403, 'forbidden', 'This payout is not yours.');
  if (!['pending', 'under_review', 'approved'].includes(payout.status)) {
    throw httpError(409, 'invalid_state', `A ${payout.status} payout cannot be cancelled.`);
  }
  db.prepare("UPDATE payout_requests SET status = 'cancelled', updated_at = ?, failure_reason = ? WHERE id = ? AND status = ?")
    .run(now(), 'Cancelled before processing.', payout.id, payout.status);
  releasePayoutHold(payout, 'payout_cancelled', ip);
  audit(actorId || payout.seller_id, 'payout.cancel', 'payout', payout.id, { amountMinor: payout.amount_minor }, ip);
  notify(payout.seller_id, { type: 'payout_cancelled', actorId: actorId || payout.seller_id, entityType: 'payout', entityId: payout.id });
  return serializePayout(getPayout(payout.id));
}

export function reviewPayout({ payoutId, actorId, decision, note = '', ip = '' }) {
  const payout = getPayout(payoutId);
  if (!payout) throw httpError(404, 'not_found', 'Payout not found.');
  const decided = String(decision || '').trim();
  const allowed = {
    review: { from: ['pending'], to: 'under_review' },
    approve: { from: ['pending', 'under_review'], to: 'approved' },
    reject: { from: ['pending', 'under_review', 'approved'], to: 'cancelled' },
  };
  const rule = allowed[decided];
  if (!rule) throw httpError(400, 'invalid_decision', 'Decision must be review, approve or reject.');
  if (!rule.from.includes(payout.status)) {
    throw httpError(409, 'invalid_state', `A ${payout.status} payout cannot be ${decided === 'reject' ? 'rejected' : decided + 'd'}.`);
  }
  if (decided === 'reject' && !String(note || '').trim()) {
    throw httpError(400, 'note_required', 'Record the reason before rejecting a payout.');
  }

  db.prepare('UPDATE payout_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, note = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(rule.to, actorId, now(), String(note || payout.note || '').slice(0, 300), now(), payout.id, payout.status);
  if (decided === 'reject') releasePayoutHold(payout, 'payout_rejected', ip);
  audit(actorId, `payout.${decided}`, 'payout', payout.id, { amountMinor: payout.amount_minor, note: String(note || '').slice(0, 300) }, ip);
  notify(payout.seller_id, { type: `payout_${rule.to}`, actorId, entityType: 'payout', entityId: payout.id, data: { note: String(note || '') } });
  return serializePayout(getPayout(payout.id));
}

/**
 * Send an approved payout to the provider. A payout only becomes `processing` when the
 * provider accepts it, and only becomes `paid` from a verified provider confirmation.
 */
export async function processPayout({ payoutId, actorId, ip = '' }) {
  const payout = getPayout(payoutId);
  if (!payout) throw httpError(404, 'not_found', 'Payout not found.');
  if (payout.status !== 'approved') throw httpError(409, 'invalid_state', 'Only an approved payout can be processed.');
  const config = paystack.paymentStatus();
  if (!config.enabled) throw httpError(503, config.reason || 'payment_not_configured', config.message);

  const bank = payout.bank_account_id
    ? db.prepare('SELECT * FROM seller_bank_accounts WHERE id = ?').get(payout.bank_account_id)
    : null;
  if (!bank || bank.status !== 'verified') throw httpError(409, 'bank_account_unverified', 'The seller bank account is not verified.');

  let recipient = bank.recipient_code;
  if (!recipient) {
    const created = await paystack.createTransferRecipient({
      name: bank.account_name || bank.resolved_account_name,
      accountNumber: decryptAccountNumber(bank.account_number_enc),
      bankCode: bank.bank_code,
    });
    if (!created.ok || !created.data?.recipient_code) {
      audit(actorId, 'payout.recipient_failed', 'payout', payout.id, { message: created.message }, ip);
      throw httpError(502, 'recipient_failed', `The provider could not create a transfer recipient: ${created.message}`);
    }
    recipient = created.data.recipient_code;
    db.prepare('UPDATE seller_bank_accounts SET recipient_code = ?, updated_at = ? WHERE id = ?').run(recipient, now(), bank.id);
  }

  const reference = `payout_${payout.id}`;
  const transfer = await paystack.initiateTransfer({
    amountMinor: payout.amount_minor,
    recipient,
    reason: '#ash Mesh seller payout',
    reference,
  });
  if (!transfer.ok) {
    db.prepare('UPDATE payout_requests SET failure_reason = ?, updated_at = ? WHERE id = ?')
      .run(String(transfer.message || 'Provider rejected the transfer.').slice(0, 300), now(), payout.id);
    audit(actorId, 'payout.provider_failed', 'payout', payout.id, { message: transfer.message }, ip);
    // The hold stays: nothing was sent, so the seller keeps the funds in the wallet.
    throw httpError(502, 'provider_failed', `The payment provider rejected the transfer: ${transfer.message}`);
  }

  db.prepare("UPDATE payout_requests SET status = 'processing', provider_ref = ?, transfer_code = ?, processed_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'")
    .run(reference, transfer.data?.transfer_code || '', now(), now(), payout.id);
  audit(actorId, 'payout.processing', 'payout', payout.id, { amountMinor: payout.amount_minor, reference }, ip);
  notify(payout.seller_id, { type: 'payout_processing', actorId, entityType: 'payout', entityId: payout.id });
  return { payout: serializePayout(getPayout(payout.id)), provider: { status: 'processing', reference } };
}

/** Called only from a signature-verified provider webhook. */
export function settlePayout({ payoutId, outcome, providerData = {}, reason = '' }) {
  const payout = getPayout(payoutId);
  if (!payout) return null;
  if (payout.status === 'paid') return payout;
  if (payout.status !== 'processing') return null;

  if (outcome === 'paid') {
    db.prepare("UPDATE payout_requests SET status = 'paid', processed_at = ?, failure_reason = '', updated_at = ? WHERE id = ? AND status = 'processing'")
      .run(now(), now(), payout.id);
    audit(payout.seller_id, 'payout.paid', 'payout', payout.id, {
      amountMinor: payout.amount_minor, transferCode: providerData?.transfer_code || payout.transfer_code || '',
    }, '');
    notify(payout.seller_id, { type: 'payout_paid', entityType: 'payout', entityId: payout.id, data: { amount: payout.amount_minor / 100 } });
    return getPayout(payout.id);
  }

  db.prepare("UPDATE payout_requests SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
    .run(String(reason || 'The provider reported a failed transfer.').slice(0, 300), now(), payout.id);
  releasePayoutHold(payout, 'payout_failed', '');
  audit(payout.seller_id, 'payout.failed', 'payout', payout.id, { amountMinor: payout.amount_minor, reason }, '');
  notify(payout.seller_id, { type: 'payout_failed', entityType: 'payout', entityId: payout.id, data: { reason } });
  return getPayout(payout.id);
}

/* ------------------------------ order balances --------------------------- */

/** On a confirmed payment: seller share becomes pending, commission becomes platform revenue. */
export function recordOrderPaid(order) {
  if (!order || !(order.payout_minor > 0)) return;
  postLedger({
    userId: order.seller_id, bucket: 'pending', direction: 'credit', amountMinor: order.payout_minor,
    reason: 'order_sale', refType: 'order', refId: order.id, idempotencyKey: `order:${order.id}:seller_pending`,
    meta: { buyerId: order.buyer_id, amountMinor: order.amount_minor, commissionMinor: order.commission_minor, rate: order.commission_rate },
  });
  if (order.commission_minor > 0) {
    postLedger({
      account: 'platform', bucket: 'available', direction: 'credit', amountMinor: order.commission_minor,
      reason: 'commission', refType: 'order', refId: order.id, idempotencyKey: `order:${order.id}:commission`,
      meta: { sellerId: order.seller_id, rate: order.commission_rate, tier: order.commission_rate },
    });
  }
}

/** Buyer confirms delivery: the seller's pending share becomes withdrawable. */
export function releaseOrderFunds(order) {
  if (!order || !(order.payout_minor > 0)) return;
  const already = db.prepare('SELECT 1 FROM wallet_ledger WHERE idempotency_key = ?').get(`order:${order.id}:release_in`);
  if (already) return;
  const hasPending = db.prepare('SELECT 1 FROM wallet_ledger WHERE idempotency_key = ?').get(`order:${order.id}:seller_pending`);
  if (!hasPending) recordOrderPaid(order);
  postLedger({
    userId: order.seller_id, bucket: 'pending', direction: 'debit', amountMinor: order.payout_minor,
    reason: 'order_release_out', refType: 'order', refId: order.id, idempotencyKey: `order:${order.id}:release_out`,
  });
  postLedger({
    userId: order.seller_id, bucket: 'available', direction: 'credit', amountMinor: order.payout_minor,
    reason: 'order_release_in', refType: 'order', refId: order.id, idempotencyKey: `order:${order.id}:release_in`,
  });
}

/* --------------------------------- refunds ------------------------------- */

export function serializeRefund(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    amountMinor: row.amount_minor,
    amount: row.amount_minor / 100,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    providerRef: row.provider_ref,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function getRefund(refundId) {
  return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
}

export function refundsForOrder(orderId) {
  return db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC').all(orderId);
}

/**
 * Start a refund. The provider is asked first; balances only move after the provider
 * confirms (webhook `refund.processed`), so no refund is ever claimed without evidence.
 */
export async function refundOrder({ orderId, actorId, amountMinor, reason, ip = '' }) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw httpError(404, 'not_found', 'Order not found.');
  if (!['paid', 'shipped', 'completed'].includes(order.status)) {
    throw httpError(409, 'invalid_state', `A ${order.status} order cannot be refunded.`);
  }
  const already = db
    .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM refunds WHERE order_id = ? AND status IN ('processing', 'completed')")
    .get(orderId).n;
  const refundable = order.amount_minor - already;
  if (refundable <= 0) throw httpError(409, 'already_refunded', 'This order has already been fully refunded.');
  const amount = amountMinor === undefined || amountMinor === null ? refundable : Number(amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) throw httpError(400, 'invalid_amount', 'Enter a valid refund amount in kobo.');
  if (amount > refundable) throw httpError(400, 'refund_exceeds_amount', `At most ${refundable / 100} can still be refunded on this order.`);
  if (!order.provider_ref) throw httpError(409, 'missing_reference', 'This order has no provider payment reference to refund.');

  // Seller and platform balances must be able to absorb the reversal; otherwise the
  // refund needs Founder review instead of silently creating a negative balance.
  const sellerPending = balance(order.seller_id, 'pending');
  const sellerAvailable = balance(order.seller_id, 'available');
  if (sellerPending + sellerAvailable < order.payout_minor) {
    throw httpError(409, 'insufficient_seller_balance', 'The seller balance cannot absorb this refund yet. Founder review is required before refunding.');
  }

  const id = uid('rfd_');
  const ts = now();
  db.prepare(
    `INSERT INTO refunds (id, order_id, amount_minor, currency, reason, status, requested_by, created_at)
     VALUES (?,?,?,?,?, 'pending', ?, ?)`
  ).run(id, orderId, amount, order.currency, String(reason || '').slice(0, 300), actorId || null, ts);
  audit(actorId, 'refund.request', 'order', orderId, { refundId: id, amountMinor: amount, reason: String(reason || '').slice(0, 300) }, ip);

  const config = paystack.paymentStatus();
  if (!config.enabled) {
    const message = 'The payment provider is not configured, so this refund is recorded but cannot be sent. No balance has been changed.';
    db.prepare('UPDATE refunds SET failure_reason = ? WHERE id = ?').run(message, id);
    return { refund: serializeRefund(getRefund(id)), provider: { status: config.reason, message } };
  }

  const result = await paystack.refundTransaction({ reference: order.provider_ref, amountMinor: amount });
  if (!result.ok) {
    db.prepare("UPDATE refunds SET status = 'failed', failure_reason = ? WHERE id = ?").run(String(result.message).slice(0, 300), id);
    audit(actorId, 'refund.provider_failed', 'order', orderId, { refundId: id, message: result.message }, ip);
    return { refund: serializeRefund(getRefund(id)), provider: { status: 'failed', message: result.message } };
  }
  db.prepare("UPDATE refunds SET status = 'processing', provider_ref = ? WHERE id = ?")
    .run(String(result.data?.reference || result.data?.id || ''), id);
  return {
    refund: serializeRefund(getRefund(id)),
    provider: { status: 'processing', message: 'Refund submitted to the provider. Balances change only after the provider confirms it.' },
  };
}

/** Settle a provider-confirmed refund and reverse the money in the ledger. */
export function completeRefund({ refundId, providerData = {} }) {
  const refund = getRefund(refundId);
  if (!refund) return null;
  if (refund.status === 'completed') return refund;
  if (refund.status !== 'processing') return null;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(refund.order_id);
  if (!order) return null;

  const payout = order.payout_minor;
  const pending = balance(order.seller_id, 'pending');
  const fromPending = Math.min(pending, payout);
  const fromAvailable = payout - fromPending;
  if (fromAvailable > balance(order.seller_id, 'available')) {
    db.prepare('UPDATE refunds SET failure_reason = ? WHERE id = ?')
      .run('Seller balance is insufficient to reverse this order; Founder review is required.', refund.id);
    audit(order.seller_id, 'refund.blocked_seller_balance', 'order', order.id, { refundId: refund.id }, '');
    notifyFounder({ type: 'refund_blocked', entityType: 'order', entityId: order.id, data: { refundId: refund.id } });
    return null;
  }

  const settle = db.transaction(() => {
    if (fromPending > 0) {
      postLedger({
        userId: order.seller_id, bucket: 'pending', direction: 'debit', amountMinor: fromPending,
        reason: 'refund_out_pending', refType: 'refund', refId: refund.id, idempotencyKey: `refund:${refund.id}:seller_pending`,
      });
    }
    if (fromAvailable > 0) {
      postLedger({
        userId: order.seller_id, bucket: 'available', direction: 'debit', amountMinor: fromAvailable,
        reason: 'refund_out_available', refType: 'refund', refId: refund.id, idempotencyKey: `refund:${refund.id}:seller_available`,
      });
    }
    if (order.commission_minor > 0) {
      postLedger({
        account: 'platform', bucket: 'available', direction: 'debit', amountMinor: order.commission_minor,
        reason: 'commission_reversal', refType: 'refund', refId: refund.id, idempotencyKey: `refund:${refund.id}:platform`,
      });
    }
    db.prepare("UPDATE refunds SET status = 'completed', completed_at = ?, failure_reason = '' WHERE id = ? AND status = 'processing'")
      .run(now(), refund.id);
    db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(now(), order.id);
    db.prepare("UPDATE transactions SET status = 'refunded' WHERE order_id = ? AND status = 'success'").run(order.id);
  });
  settle();

  audit(order.seller_id, 'refund.completed', 'order', order.id, {
    refundId: refund.id, amountMinor: refund.amount_minor, sellerReversed: payout, commissionReversed: order.commission_minor,
    providerRef: providerData?.reference || refund.provider_ref || '',
  }, '');
  notify(order.buyer_id, { type: 'order_refunded', entityType: 'order', entityId: order.id, data: { amount: refund.amount_minor / 100 } });
  notify(order.seller_id, { type: 'order_refunded', entityType: 'order', entityId: order.id, data: { amount: refund.amount_minor / 100 } });
  return getRefund(refund.id);
}

/* --------------------------------- views --------------------------------- */

export function walletSummary(userId) {
  const ledger = db
    .prepare("SELECT * FROM wallet_ledger WHERE account = 'user' AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100")
    .all(userId);
  const lifetime = db
    .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM wallet_ledger WHERE account = 'user' AND user_id = ? AND direction = 'credit' AND reason = 'order_sale'")
    .get(userId).n;
  return {
    currency: 'NGN',
    availableMinor: balance(userId, 'available'),
    pendingMinor: balance(userId, 'pending'),
    lifetimeEarnedMinor: lifetime,
    payoutMinimumMinor: PAYOUT_MIN_MINOR,
    ledger: ledger.map(serializeLedger),
    payouts: payoutsForSeller(userId).map(serializePayout),
    bankAccount: publicBankAccount(userId),
    paymentConfig: paystack.paymentStatus(),
  };
}

export function founderWalletOverview() {
  const paidStatuses = ['paid', 'shipped', 'completed', 'refunded'];
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_minor), 0) AS salesMinor,
              COALESCE(SUM(commission_minor), 0) AS commissionMinor, COALESCE(SUM(payout_minor), 0) AS sellerMinor
       FROM orders WHERE status IN (${paidStatuses.map(() => '?').join(',')})`
    )
    .get(...paidStatuses);
  const byRate = db
    .prepare(
      `SELECT commission_rate AS rate, COUNT(*) AS orders, COALESCE(SUM(amount_minor), 0) AS salesMinor,
              COALESCE(SUM(commission_minor), 0) AS commissionMinor
       FROM orders WHERE status IN (${paidStatuses.map(() => '?').join(',')}) GROUP BY commission_rate ORDER BY commission_rate DESC`
    )
    .all(...paidStatuses);
  const payoutRows = db
    .prepare('SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS amountMinor FROM payout_requests GROUP BY status')
    .all();
  return {
    currency: 'NGN',
    totals: {
      orders: totals.orders,
      salesMinor: totals.salesMinor,
      commissionMinor: totals.commissionMinor,
      sellerMinor: totals.sellerMinor,
    },
    commissionByRate: byRate.map((r) => ({
      rate: r.rate,
      percentLabel: `${Math.round(r.rate * 10000) / 100}%`,
      orders: r.orders,
      salesMinor: r.salesMinor,
      commissionMinor: r.commissionMinor,
    })),
    platformBalanceMinor: platformBalance('available'),
    payouts: payoutRows,
    payoutQueue: payoutQueue().map(serializePayout),
    recentRefunds: db
      .prepare('SELECT * FROM refunds ORDER BY created_at DESC LIMIT 20')
      .all()
      .map(serializeRefund),
    paymentConfig: paystack.paymentStatus(),
    ledgerIntegrity: {
      entries: db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger').get().n,
      duplicateKeys: db
        .prepare('SELECT COUNT(*) AS n FROM (SELECT idempotency_key FROM wallet_ledger GROUP BY idempotency_key HAVING COUNT(*) > 1)')
        .get().n,
    },
  };
}

export function metaOf(row) {
  return parseJSON(row?.meta, {});
}
