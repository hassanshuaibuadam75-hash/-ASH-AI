// #ash Mesh — Paystack provider client (server side only).
//
// The secret key is read from the server environment on every call. It is never
// returned to a client, written to the database, logged or committed to Git.
//
// TEST-stage guard: a LIVE key is refused unless the operator explicitly sets
// PAYSTACK_ALLOW_LIVE=1, so Stage D cannot accidentally move real money while the
// integration is still being tested. Nothing in this module invents a payment: when
// the provider is unreachable or unconfigured the caller gets a failure it must report.
import crypto from 'node:crypto';

const DEFAULT_BASE = 'https://api.paystack.co';

export function paystackKey() {
  return String(process.env.PAYSTACK_SECRET_KEY || '').trim();
}

/** 'unconfigured' | 'test' | 'live' — derived from the key prefix only. */
export function paystackMode() {
  const key = paystackKey();
  if (!key) return 'unconfigured';
  if (/^(sk|pk)_live_/i.test(key)) return 'live';
  return 'test';
}

export function livePaymentsAllowed() {
  return String(process.env.PAYSTACK_ALLOW_LIVE || '') === '1';
}

/**
 * Whether provider calls may be made at all. Returns an explanation instead of
 * throwing so routes can report an honest "not configured" state to the user.
 */
export function paymentStatus() {
  const mode = paystackMode();
  if (mode === 'unconfigured') {
    return {
      enabled: false,
      mode,
      reason: 'not_configured',
      message:
        'Online payment is not configured on this deployment. Set PAYSTACK_SECRET_KEY (test mode) to enable real card/bank payment and payouts.',
    };
  }
  if (mode === 'live' && !livePaymentsAllowed()) {
    return {
      enabled: false,
      mode,
      reason: 'live_key_blocked',
      message:
        'A LIVE Paystack key is configured. Stage D refuses to move real money until the Founder authorises live payments (PAYSTACK_ALLOW_LIVE=1).',
    };
  }
  return { enabled: true, mode, reason: null, message: `Paystack ${mode} mode is configured.` };
}

function baseUrl() {
  return String(process.env.PAYSTACK_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

function providerError(status, error, message) {
  const err = new Error(message);
  err.status = status;
  err.error = error;
  return err;
}

async function callProvider(pathname, { method = 'GET', body } = {}) {
  const key = paystackKey();
  if (!key) throw providerError(503, 'payment_not_configured', 'Payment provider is not configured on this deployment.');
  let response;
  try {
    response = await fetch(`${baseUrl()}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw providerError(502, 'provider_unreachable', `Payment provider could not be reached: ${err.message}`);
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return {
    ok: response.ok && payload?.status === true,
    status: response.status,
    message: payload?.message || (response.ok ? 'Provider rejected the request.' : `Provider returned HTTP ${response.status}.`),
    data: payload?.data ?? null,
  };
}

export function initializeTransaction({ email, amountMinor, reference, callbackUrl, metadata }) {
  return callProvider('/transaction/initialize', {
    method: 'POST',
    body: { email, amount: amountMinor, currency: 'NGN', reference, callback_url: callbackUrl, metadata },
  });
}

export function verifyTransaction(reference) {
  return callProvider(`/transaction/verify/${encodeURIComponent(reference)}`);
}

export function refundTransaction({ reference, amountMinor }) {
  return callProvider('/refund', {
    method: 'POST',
    body: { transaction: reference, amount: amountMinor, merchant_note: '#ash Mesh refund' },
  });
}

export function listBanks() {
  return callProvider('/bank?currency=NGN');
}

export function resolveAccountNumber({ accountNumber, bankCode }) {
  return callProvider(
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
  );
}

export function createTransferRecipient({ name, accountNumber, bankCode }) {
  return callProvider('/transferrecipient', {
    method: 'POST',
    body: { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' },
  });
}

export function initiateTransfer({ amountMinor, recipient, reason, reference }) {
  return callProvider('/transfer', {
    method: 'POST',
    body: { source: 'balance', amount: amountMinor, recipient, reason, reference, currency: 'NGN' },
  });
}

export function verifyTransfer(reference) {
  return callProvider(`/transfer/verify/${encodeURIComponent(reference)}`);
}

/**
 * Verify a webhook using the raw request body. A forged, truncated or replayed
 * signature never reaches a state change.
 */
export function verifyWebhookSignature(rawBody, signature) {
  const secret = paystackKey();
  if (!secret) return { ok: false, reason: 'not_configured' };
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  const given = String(signature || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(given) || given.length !== expected.length) {
    return { ok: false, reason: 'invalid_signature' };
  }
  const ok = crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  return ok ? { ok: true, reason: null } : { ok: false, reason: 'invalid_signature' };
}
