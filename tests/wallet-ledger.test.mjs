// #ash Mesh — Stage D: Paystack, wallet ledger, refunds and payouts.
//
// Boots the REAL server against isolated temporary data directories and proves:
//
//   with no provider configured nothing pretends to work: payment initialisation,
//     provider verification and webhooks return 503, a saved bank account stays
//     unverified and payouts are blocked with a clear reason
//   with a provider configured, an order is only paid after the provider confirms the
//     exact amount, and the seller share plus the platform commission reach the ledger
//     exactly once
//   webhook signatures are verified, replayed deliveries are ignored, and an event
//     reporting a short payment never credits a balance
//   buyer confirmation releases the seller's pending share, then the payout moves
//     hold -> under review -> approved -> processing -> paid, and a failed transfer
//     returns the held funds instead of losing them
//   only the Founder can review, process or inspect payouts; an unrelated user cannot
//     refund someone else's order
//   a provider-confirmed refund reverses the seller share and the commission, while an
//     over-refund or a repeat refund is refused
//   the provider secret never appears in any client response
//
//   node tests/wallet-ledger.test.mjs
//
// The provider is a local SIMULATED Paystack-shaped HTTP server on 127.0.0.1 so the real
// integration code runs end to end (signed webhooks, exact amounts, transfer recipient).
// It is a simulation and is labelled as one: no real money, no LIVE credentials, no
// request leaves this machine, and nothing here touches the LIVE deployment or Supabase.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FOUNDER_EMAIL = 'founder@ashmesh.test';
const FOUNDER_PASSWORD = 'FounderPass123';
const SECRET = 'sk_test_stage_d_simulated_1234567890';
const PROVIDER_PORT = 4332;

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        \u21b3 ${detail}`}`);
  return ok;
}

/* ------------------------------- http client ------------------------------ */

function makeClient(base) {
  const cookies = new Map();
  async function request(method, pathname, { json, form, headers = {} } = {}) {
    const h = { ...headers };
    if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = cookies.get('ash_csrf');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    let body;
    if (form) body = form;
    else if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + pathname, { method, headers: h, body });
    for (const cookie of res.headers.getSetCookie?.() || []) {
      const pair = cookie.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }
  return { get: (p, o) => request('GET', p, o), post: (p, o) => request('POST', p, o) };
}

async function waitReady(base) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await fetch(`${base}/api/auth/me`);
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready on ${base}`);
}

function bootServer({ port, dataDir, env = {} }) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'ash-mesh.db'),
      FORCE_INSECURE_COOKIES: '1',
      FOUNDER_EMAIL,
      FOUNDER_PASSWORD,
      GROQ_API_KEY: '',
      RESEND_API_KEY: '',
      BACKUP_SCHEDULER: 'off',
      NODE_ENV: 'test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += d.toString();
  });
  child.stderr.on('data', (d) => {
    log += d.toString();
  });
  return { child, log: () => log };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* --------------------------- simulated provider --------------------------
   A Paystack-shaped local server. It answers only the endpoints the integration
   uses, echoes back the reference the server generated, and lets a test override
   the amount reported by /transaction/verify to prove a short payment is refused.
   Nothing is charged and no real account exists.                            */

function startFakeProvider(port) {
  const initiations = new Map();
  const overrides = new Map();
  const state = { recipients: 0, transfers: 0, refunds: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (payload, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const p = url.pathname;

      if (p === '/bank') {
        return send({
          status: true,
          message: 'Banks retrieved',
          data: [
            { name: 'Access Bank', code: '044', currency: 'NGN' },
            { name: 'GTBank', code: '058', currency: 'NGN' },
          ],
        });
      }
      if (p === '/bank/resolve') {
        return send({
          status: true,
          message: 'Account number resolved',
          data: { account_number: url.searchParams.get('account_number'), account_name: 'STAGE D SELLER' },
        });
      }
      if (p === '/transaction/initialize') {
        const reference = body.reference || `sim_${initiations.size + 1}`;
        initiations.set(reference, {
          amount: Number(body.amount),
          currency: body.currency || 'NGN',
          email: body.email,
        });
        return send({
          status: true,
          message: 'Authorization URL created',
          data: {
            authorization_url: `http://127.0.0.1:${port}/simulated-checkout/${reference}`,
            access_code: `ac_${reference}`,
            reference,
          },
        });
      }
      if (p.startsWith('/transaction/verify/')) {
        const reference = decodeURIComponent(p.slice('/transaction/verify/'.length));
        const record = initiations.get(reference);
        const amount = overrides.has(reference) ? overrides.get(reference) : record?.amount ?? 0;
        return send({
          status: true,
          message: 'Verification successful',
          data: {
            id: 9000 + initiations.size,
            status: 'success',
            reference,
            amount,
            currency: record?.currency || 'NGN',
            gateway_response: 'Successful',
            paid_at: new Date().toISOString(),
          },
        });
      }
      if (p === '/refund') {
        state.refunds += 1;
        return send({
          status: true,
          message: 'Refund has been queued for processing',
          data: {
            id: 7000 + state.refunds,
            reference: `sim_refund_${state.refunds}`,
            status: 'processed',
            amount: Number(body.amount),
            transaction: { reference: body.transaction },
          },
        });
      }
      if (p === '/transferrecipient') {
        state.recipients += 1;
        return send({
          status: true,
          message: 'Transfer recipient created',
          data: { recipient_code: `RCP_sim_${state.recipients}`, type: 'nuban', details: body },
        });
      }
      if (p === '/transfer') {
        state.transfers += 1;
        return send({
          status: true,
          message: 'Transfer has been queued',
          data: { transfer_code: `TRF_sim_${state.transfers}`, status: 'success', reference: body.reference },
        });
      }
      if (p.startsWith('/transfer/verify/')) {
        return send({
          status: true,
          message: 'Transfer retrieved',
          data: { status: 'success', reference: decodeURIComponent(p.slice('/transfer/verify/'.length)) },
        });
      }
      return send({ status: false, message: `Unsupported simulated endpoint ${p}` }, 404);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        state,
        overrideAmount: (reference, amount) => overrides.set(reference, amount),
        stop: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      })
    );
  });
}

/* --------------------------------- helpers -------------------------------- */

function sign(raw, secret = SECRET) {
  return crypto.createHmac('sha512', secret).update(raw).digest('hex');
}

function makeDeliverer(base) {
  return async function deliver(event, { secret = SECRET } = {}) {
    const raw = JSON.stringify(event);
    const res = await fetch(`${base}/api/market/payments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(raw, secret) },
      body: raw,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  };
}

async function register(client, { fullName, username, password, email }) {
  const res = await client.post('/api/auth/register', { json: { fullName, username, password, email } });
  if (res.status !== 201) throw new Error(`register ${username} failed ${res.status} ${JSON.stringify(res.data)}`);
  const me = await client.get('/api/auth/me');
  const user = me.data?.user;
  if (!user?.id) throw new Error(`no session for ${username}: ${JSON.stringify(me.data)}`);
  return user;
}

function makeLedger(db) {
  const sum = (where, params) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS n
         FROM wallet_ledger WHERE ${where}`
      )
      .get(...params).n;
  return {
    sellerPending: (userId) => sum('user_id = ? AND bucket = ?', [userId, 'pending']),
    sellerAvailable: (userId) => sum('user_id = ? AND bucket = ?', [userId, 'available']),
    platformAvailable: () => sum("account = 'platform' AND bucket = 'available'", []),
    keyCount: (key) => db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger WHERE idempotency_key = ?').get(key).n,
    orderRows: (orderId) => db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger WHERE ref_id = ?').get(orderId).n,
    auditCount: (action) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%audit%'")
        .all()
        .map((r) => r.name);
      let total = 0;
      for (const table of tables) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes('action')) continue;
        total += db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE action = ?`).get(action).n;
      }
      return total;
    },
  };
}

async function createListing(client, priceNaira, title) {
  const form = new FormData();
  form.set('title', title);
  form.set('description', 'Stage D wallet and payout integrity listing.');
  form.set('category', 'general');
  form.set('location', 'Kano');
  form.set('price', String(priceNaira));
  const res = await client.post('/api/market/listings', { form });
  if (res.status !== 201) throw new Error(`listing create failed ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.listing;
}

async function createOrder(buyer, listingId, key) {
  return buyer.post(`/api/market/listings/${listingId}/orders`, {
    json: { deliveryNote: 'Stage D test order' },
    headers: { 'Idempotency-Key': key },
  });
}

/* ------------------------- boot 1: no provider configured ------------------ */

async function runUnconfigured() {
  const port = 4330;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-staged-off-'));
  const server = bootServer({ port, dataDir, env: { PAYSTACK_SECRET_KEY: '' } });
  let db;

  try {
    await waitReady(base);
    db = new Database(path.join(dataDir, 'ash-mesh.db'));
    const ledger = makeLedger(db);
    const deliver = makeDeliverer(base);

    const seller = makeClient(base);
    const buyer = makeClient(base);
    const sellerUser = await register(seller, {
      fullName: 'Unconfigured Seller',
      username: 'stagedoffseller',
      password: 'SellerPass123',
      email: 'offseller@staged.test',
    });
    await register(buyer, {
      fullName: 'Unconfigured Buyer',
      username: 'stagedoffbuyer',
      password: 'BuyerPass123',
      email: 'offbuyer@staged.test',
    });

    const overview = await seller.get('/api/wallet');
    check('a wallet overview is served for a new account', overview.status === 200 && !!overview.data?.wallet,
      `${overview.status} ${JSON.stringify(overview.data).slice(0, 160)}`);
    check('with no provider the bank list is empty and says why',
      overview.data?.banks?.configured === false &&
        Array.isArray(overview.data.banks.list) &&
        overview.data.banks.list.length === 0 &&
        typeof overview.data.banks.message === 'string' &&
        overview.data.banks.message.length > 10,
      JSON.stringify(overview.data?.banks));

    const bank = await seller.post('/api/wallet/bank-account', {
      json: { bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Unconfigured Seller' },
    });
    check('bank details are stored but left unverified without a provider',
      bank.status === 200 && bank.data?.bankAccount?.status === 'unverified',
      `${bank.status} ${JSON.stringify(bank.data).slice(0, 200)}`);
    check('the stored account number is never returned in full',
      bank.data?.bankAccount?.maskedAccountNumber?.endsWith('6789') &&
        !JSON.stringify(bank.data).includes('0123456789'),
      JSON.stringify(bank.data?.bankAccount));

    const blockedPayout = await seller.post('/api/wallet/payouts', { json: { amountMinor: 50000 } });
    check('a payout is refused while the bank account is unverified',
      blockedPayout.status === 409 && blockedPayout.data?.error === 'bank_account_unverified',
      `${blockedPayout.status} ${JSON.stringify(blockedPayout.data)}`);

    const listing = await createListing(seller, 5000, 'Stage D unconfigured listing');
    const order = await createOrder(buyer, listing.id, 'staged-off-order-1');
    check('an order can be created without a provider', order.status === 201 && !!order.data?.order?.id,
      `${order.status} ${JSON.stringify(order.data).slice(0, 160)}`);

    const pay = await buyer.post(`/api/market/orders/${order.data.order.id}/pay`, { json: {} });
    check('payment initialisation reports honestly that no provider is configured',
      pay.status === 200 && pay.data?.payment?.status === 'not_configured' &&
        typeof pay.data.payment.message === 'string' && pay.data.payment.message.length > 20,
      `${pay.status} ${JSON.stringify(pay.data).slice(0, 200)}`);
    const unpaid = db.prepare('SELECT status, provider_ref FROM orders WHERE id = ?').get(order.data.order.id);
    check('an unconfigured order stays pending with no provider reference',
      unpaid?.status === 'pending_payment' && unpaid?.provider_ref === null, JSON.stringify(unpaid));

    const verify = await buyer.get('/api/market/payments/verify?reference=anything');
    check('provider verification also reports 503 instead of a fake success', verify.status === 503,
      `${verify.status} ${JSON.stringify(verify.data).slice(0, 160)}`);

    const hook = await deliver({ id: 'evt_off_1', event: 'charge.success', data: { reference: 'anything', amount: 500000 } });
    check('an unconfigured deployment rejects webhooks instead of trusting them', hook.status === 503,
      `${hook.status} ${JSON.stringify(hook.data).slice(0, 160)}`);

    check('no balance was invented anywhere', ledger.sellerPending(sellerUser.id) === 0 && ledger.platformAvailable() === 0,
      `pending=${ledger.sellerPending(sellerUser.id)} platform=${ledger.platformAvailable()}`);
  } finally {
    if (db) db.close();
    await stopServer(server.child);
    if (failures) console.log(server.log().split('\n').slice(-25).join('\n'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/* ----------------------- boot 2: simulated provider ------------------------ */

async function runConfigured(provider) {
  const port = 4331;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-staged-on-'));
  const server = bootServer({
    port,
    dataDir,
    env: {
      PAYSTACK_SECRET_KEY: SECRET,
      PAYSTACK_API_BASE: `http://127.0.0.1:${PROVIDER_PORT}`,
    },
  });
  let db;

  try {
    await waitReady(base);
    db = new Database(path.join(dataDir, 'ash-mesh.db'));
    const ledger = makeLedger(db);
    const deliver = makeDeliverer(base);

    const seller = makeClient(base);
    const buyer = makeClient(base);
    const stranger = makeClient(base);
    const founder = makeClient(base);

    const sellerUser = await register(seller, {
      fullName: 'Stage D Seller',
      username: 'stagedseller',
      password: 'SellerPass123',
      email: 'seller@staged.test',
    });
    const buyerUser = await register(buyer, {
      fullName: 'Stage D Buyer',
      username: 'stagedbuyer',
      password: 'BuyerPass123',
      email: 'buyer@staged.test',
    });
    await register(stranger, {
      fullName: 'Stage D Stranger',
      username: 'stagedstranger',
      password: 'StrangerPass123',
      email: 'stranger@staged.test',
    });
    const founderLogin = await founder.post('/api/auth/login', {
      json: { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD },
    });
    check('the Founder signs in with server-verified Founder authority',
      founderLogin.status === 200 && founderLogin.data?.user?.isFounder === true,
      `${founderLogin.status} ${JSON.stringify(founderLogin.data?.user || founderLogin.data).slice(0, 160)}`);

    /* ---------------------------- bank account ---------------------------- */

    const mismatch = await seller.post('/api/wallet/bank-account', {
      json: { bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Wrong Holder Name' },
    });
    check('a bank name that disagrees with the provider is flagged, not trusted',
      mismatch.status === 200 && mismatch.data?.bankAccount?.status === 'name_mismatch',
      `${mismatch.status} ${JSON.stringify(mismatch.data?.bankAccount)}`);

    const mismatchPayout = await seller.post('/api/wallet/payouts', { json: { amountMinor: 50000 } });
    check('payouts stay blocked while the bank name does not match',
      mismatchPayout.status === 409 && mismatchPayout.data?.error === 'bank_account_unverified',
      `${mismatchPayout.status} ${JSON.stringify(mismatchPayout.data)}`);

    const bank = await seller.post('/api/wallet/bank-account', {
      json: { bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Stage D Seller' },
    });
    check('a matching account name is verified with the provider',
      bank.status === 200 && bank.data?.bankAccount?.status === 'verified',
      `${bank.status} ${JSON.stringify(bank.data?.bankAccount)}`);

    const banks = await seller.get('/api/wallet/banks');
    check('the bank list is the provider list, not an invented one',
      banks.status === 200 && banks.data?.banks?.list?.some((b) => b.code === '058'),
      JSON.stringify(banks.data?.banks).slice(0, 200));

    /* ------------------- order A: pay, then refund it -------------------- */

    const listingA = await createListing(seller, 5000, 'Stage D refund order');
    const orderA = await createOrder(buyer, listingA.id, 'staged-refund-order-1');
    check('order A awaits payment', orderA.status === 201 && orderA.data?.order?.status === 'pending_payment',
      `${orderA.status} ${JSON.stringify(orderA.data?.order).slice(0, 160)}`);
    const idA = orderA.data.order.id;

    const payA = await buyer.post(`/api/market/orders/${idA}/pay`, { json: {} });
    check('payment initialises through the provider', payA.status === 200 && !!payA.data?.payment,
      `${payA.status} ${JSON.stringify(payA.data).slice(0, 200)}`);
    const refA = payA.data?.payment?.reference || db.prepare('SELECT provider_ref FROM orders WHERE id = ?').get(idA)?.provider_ref;
    check('the order carries the provider reference', typeof refA === 'string' && refA.length > 0,
      `payment=${JSON.stringify(payA.data?.payment)} stored=${String(db.prepare('SELECT provider_ref FROM orders WHERE id = ?').get(idA)?.provider_ref)}`);

    check('no balance exists before the provider confirms',
      ledger.sellerPending(sellerUser.id) === 0 && ledger.platformAvailable() === 0,
      `pending=${ledger.sellerPending(sellerUser.id)} platform=${ledger.platformAvailable()}`);

    const verifyA = await buyer.get(`/api/market/payments/verify?reference=${encodeURIComponent(refA)}`);
    check('provider verification marks the order paid',
      verifyA.status === 200 && verifyA.data?.verified === true && verifyA.data?.order?.status === 'paid',
      `${verifyA.status} ${JSON.stringify(verifyA.data).slice(0, 200)}`);
    check('the seller share is credited to the pending bucket', ledger.sellerPending(sellerUser.id) === 485000,
      `expected 485000, got ${ledger.sellerPending(sellerUser.id)}`);
    check('the 3% commission is credited to the platform account', ledger.platformAvailable() === 15000,
      `expected 15000, got ${ledger.platformAvailable()}`);
    check('one sale writes exactly two ledger entries', ledger.orderRows(idA) === 2,
      `rows=${ledger.orderRows(idA)}`);
    const walletCfg = await seller.get('/api/wallet');
    check('the provider secret never reaches a client',
      ![walletCfg, payA, verifyA, banks].some((r) => JSON.stringify(r?.data || {}).includes(SECRET)),
      'a response contained the secret');

    const verifyAgain = await buyer.get(`/api/market/payments/verify?reference=${encodeURIComponent(refA)}`);
    check('repeating verification does not credit the seller twice',
      verifyAgain.data?.order?.status === 'paid' &&
        ledger.sellerPending(sellerUser.id) === 485000 &&
        ledger.platformAvailable() === 15000,
      `pending=${ledger.sellerPending(sellerUser.id)} platform=${ledger.platformAvailable()}`);

    /* ---------------------------- webhook safety -------------------------- */

    const paidEvent = {
      id: 'evt_staged_paid_1',
      event: 'charge.success',
      data: { id: 9001, reference: refA, amount: 500000, currency: 'NGN', status: 'success' },
    };
    const hookFirst = await deliver(paidEvent);
    check('a correctly signed webhook is accepted', hookFirst.status === 200 && hookFirst.data?.ok === true,
      `${hookFirst.status} ${JSON.stringify(hookFirst.data)}`);
    const hookReplay = await deliver(paidEvent);
    check('a replayed webhook delivery is recognised as a duplicate',
      hookReplay.status === 200 && hookReplay.data?.duplicate === true,
      `${hookReplay.status} ${JSON.stringify(hookReplay.data)}`);
    check('a replayed webhook changes no balance',
      ledger.sellerPending(sellerUser.id) === 485000 && ledger.platformAvailable() === 15000,
      `pending=${ledger.sellerPending(sellerUser.id)} platform=${ledger.platformAvailable()}`);

    const forged = await deliver(paidEvent, { secret: 'sk_test_forged_signature_value' });
    check('a forged webhook signature is rejected', forged.status === 401, `${forged.status} ${JSON.stringify(forged.data)}`);

    const shortEvent = {
      id: 'evt_staged_short_1',
      event: 'charge.success',
      data: { id: 9002, reference: refA, amount: 499999, currency: 'NGN', status: 'success' },
    };
    const shortHook = await deliver(shortEvent);
    check('a webhook reporting a short payment is not accepted as payment',
      shortHook.status === 200 && shortHook.data?.outcome === 'amount_mismatch' &&
        ledger.sellerPending(sellerUser.id) === 485000,
      `${shortHook.status} ${JSON.stringify(shortHook.data)} pending=${ledger.sellerPending(sellerUser.id)}`);

    /* ------------------------------ refunds ------------------------------ */

    const strangerRefund = await stranger.post(`/api/wallet/orders/${idA}/refund`, {
      json: { reason: 'not my order' },
    });
    check("an unrelated user cannot refund someone else's order",
      strangerRefund.status === 403 && strangerRefund.data?.error === 'forbidden',
      `${strangerRefund.status} ${JSON.stringify(strangerRefund.data)}`);

    const overRefund = await founder.post(`/api/wallet/orders/${idA}/refund`, {
      json: { amountMinor: 600000, reason: 'more than the order' },
    });
    check('a refund larger than the order is refused',
      overRefund.status === 400 && overRefund.data?.error === 'refund_exceeds_amount',
      `${overRefund.status} ${JSON.stringify(overRefund.data)}`);

    const refund = await founder.post(`/api/wallet/orders/${idA}/refund`, {
      json: { reason: 'Buyer cancelled before delivery' },
    });
    check('a refund is submitted to the provider and left processing',
      refund.status === 200 && refund.data?.refund?.status === 'processing' &&
        refund.data?.provider?.status === 'processing',
      `${refund.status} ${JSON.stringify(refund.data).slice(0, 240)}`);
    check('no balance moves before the provider confirms the refund',
      ledger.sellerPending(sellerUser.id) === 485000 && ledger.platformAvailable() === 15000,
      `pending=${ledger.sellerPending(sellerUser.id)} platform=${ledger.platformAvailable()}`);

    const refundRow = db.prepare('SELECT * FROM refunds WHERE order_id = ?').get(idA);
    const refundHook = await deliver({
      id: 'evt_staged_refund_1',
      event: 'refund.processed',
      data: {
        id: 'sim_refund_1',
        reference: refundRow?.provider_ref || 'sim_refund_1',
        transaction_reference: refA,
        status: 'processed',
      },
    });
    check('the provider-confirmed refund completes',
      refundHook.data?.outcome === 'refund_completed' &&
        db.prepare('SELECT status FROM refunds WHERE id = ?').get(refundRow.id)?.status === 'completed',
      `${refundHook.status} ${JSON.stringify(refundHook.data)}`);
    check('the refund reverses both the seller share and the commission',
      ledger.sellerPending(sellerUser.id) === 0 && ledger.platformAvailable() === 0,
      `pending=${ledger.sellerPending(sellerUser.id)} platform=${ledger.platformAvailable()}`);

    const repeatRefund = await founder.post(`/api/wallet/orders/${idA}/refund`, {
      json: { reason: 'again' },
    });
    check('a fully refunded order cannot be refunded again',
      repeatRefund.status === 409 && ['invalid_state', 'already_refunded'].includes(repeatRefund.data?.error) &&
        /refunded/i.test(String(repeatRefund.data?.message || '')),
      `${repeatRefund.status} ${JSON.stringify(repeatRefund.data)}`);

    /* ------------------ order C: short payment is never paid ------------- */

    const listingC = await createListing(seller, 2000, 'Stage D short payment order');
    const orderC = await createOrder(buyer, listingC.id, 'staged-short-order-1');
    const idC = orderC.data.order.id;
    await buyer.post(`/api/market/orders/${idC}/pay`, { json: {} });
    const refC = db.prepare('SELECT provider_ref FROM orders WHERE id = ?').get(idC)?.provider_ref;
    provider.overrideAmount(refC, 199999);
    const verifyC = await buyer.get(`/api/market/payments/verify?reference=${encodeURIComponent(refC)}`);
    check('a short provider payment is not accepted as a paid order',
      verifyC.status === 200 && verifyC.data?.verified === false &&
        verifyC.data?.order?.status === 'pending_payment',
      `${verifyC.status} ${JSON.stringify(verifyC.data).slice(0, 200)}`);
    check('the blocked amount mismatch is recorded in the audit trail',
      ledger.auditCount('order.amount_mismatch_blocked') >= 1,
      `audit rows=${ledger.auditCount('order.amount_mismatch_blocked')}`);

    /* ------------------- order B: release and pay the seller ------------- */

    const listingB = await createListing(seller, 5000, 'Stage D payout order');
    const orderB = await createOrder(buyer, listingB.id, 'staged-payout-order-1');
    const idB = orderB.data.order.id;
    await buyer.post(`/api/market/orders/${idB}/pay`, { json: {} });
    const refB = db.prepare('SELECT provider_ref FROM orders WHERE id = ?').get(idB)?.provider_ref;
    const verifyB = await buyer.get(`/api/market/payments/verify?reference=${encodeURIComponent(refB)}`);
    check('order B is paid after provider confirmation',
      verifyB.data?.verified === true && verifyB.data?.order?.status === 'paid',
      JSON.stringify(verifyB.data).slice(0, 200));
    check('order B credits the seller pending bucket', ledger.sellerPending(sellerUser.id) === 485000,
      `pending=${ledger.sellerPending(sellerUser.id)}`);

    const complete = await buyer.post(`/api/market/orders/${idB}/status`, { json: { status: 'completed' } });
    check('the buyer can confirm delivery', complete.status === 200 && complete.data?.order?.status === 'completed',
      `${complete.status} ${JSON.stringify(complete.data).slice(0, 200)}`);
    check('release moves the seller share from pending to available',
      ledger.sellerPending(sellerUser.id) === 0 && ledger.sellerAvailable(sellerUser.id) === 485000,
      `pending=${ledger.sellerPending(sellerUser.id)} available=${ledger.sellerAvailable(sellerUser.id)}`);

    /* ------------------------------ payouts ------------------------------ */

    const payoutRes = await seller.post('/api/wallet/payouts', {
      json: { amountMinor: 485000, note: 'Stage D payout', idempotencyKey: 'staged-payout-key-1' },
    });
    check('a payout request is created as pending',
      payoutRes.status === 201 && payoutRes.data?.payout?.status === 'pending',
      `${payoutRes.status} ${JSON.stringify(payoutRes.data?.payout).slice(0, 200)}`);
    const payoutId = payoutRes.data?.payout?.id;
    check('the requested amount leaves the available balance immediately',
      ledger.sellerAvailable(sellerUser.id) === 0, `available=${ledger.sellerAvailable(sellerUser.id)}`);

    const payoutDup = await seller.post('/api/wallet/payouts', {
      json: { amountMinor: 485000, idempotencyKey: 'staged-payout-key-1' },
    });
    check('the same idempotency key returns the original payout',
      payoutDup.status === 200 && payoutDup.data?.duplicate === true && payoutDup.data?.payout?.id === payoutId,
      `${payoutDup.status} ${JSON.stringify(payoutDup.data?.payout).slice(0, 160)}`);
    check('a duplicate request does not hold the funds twice',
      ledger.keyCount(`payout:${payoutId}:hold`) === 1 && ledger.sellerAvailable(sellerUser.id) === 0,
      `holds=${ledger.keyCount(`payout:${payoutId}:hold`)}`);

    const tooBig = await seller.post('/api/wallet/payouts', { json: { amountMinor: 99999999 } });
    check('a payout above the available balance is refused',
      tooBig.status === 409 && tooBig.data?.error === 'insufficient_balance',
      `${tooBig.status} ${JSON.stringify(tooBig.data)}`);
    const negative = await seller.post('/api/wallet/payouts', { json: { amountMinor: -5000 } });
    check('a negative payout amount is refused',
      negative.status === 400 && negative.data?.error === 'invalid_amount',
      `${negative.status} ${JSON.stringify(negative.data)}`);
    const tiny = await seller.post('/api/wallet/payouts', { json: { amountMinor: 5000 } });
    check('a payout below the minimum is refused',
      tiny.status === 400 && tiny.data?.error === 'amount_too_small',
      `${tiny.status} ${JSON.stringify(tiny.data)}`);

    const buyerReview = await buyer.post(`/api/wallet/payouts/${payoutId}/review`, { json: { decision: 'approve' } });
    check('a non-Founder cannot approve a payout', buyerReview.status === 403,
      `${buyerReview.status} ${JSON.stringify(buyerReview.data)}`);
    const sellerReview = await seller.post(`/api/wallet/payouts/${payoutId}/review`, { json: { decision: 'approve' } });
    check('a seller cannot approve their own payout', sellerReview.status === 403,
      `${sellerReview.status} ${JSON.stringify(sellerReview.data)}`);
    const buyerOverview = await buyer.get('/api/wallet/founder');
    check('the Founder payout overview is Founder-only', buyerOverview.status === 403,
      `${buyerOverview.status} ${JSON.stringify(buyerOverview.data)}`);
    const founderOverview = await founder.get('/api/wallet/founder');
    check('the Founder can read the payout overview',
      founderOverview.status === 200 && !!founderOverview.data?.overview,
      `${founderOverview.status} ${JSON.stringify(founderOverview.data).slice(0, 160)}`);

    const earlyProcess = await founder.post(`/api/wallet/payouts/${payoutId}/process`, { json: {} });
    check('an unapproved payout cannot be processed',
      earlyProcess.status === 409 && earlyProcess.data?.error === 'invalid_state',
      `${earlyProcess.status} ${JSON.stringify(earlyProcess.data)}`);

    const review = await founder.post(`/api/wallet/payouts/${payoutId}/review`, {
      json: { decision: 'review', note: 'Checking the bank details' },
    });
    check('the Founder can move a payout to under review',
      review.status === 200 && review.data?.payout?.status === 'under_review',
      `${review.status} ${JSON.stringify(review.data?.payout).slice(0, 160)}`);
    const approve = await founder.post(`/api/wallet/payouts/${payoutId}/review`, {
      json: { decision: 'approve', note: 'Verified seller and bank account' },
    });
    check('the Founder can approve the payout',
      approve.status === 200 && approve.data?.payout?.status === 'approved',
      `${approve.status} ${JSON.stringify(approve.data?.payout).slice(0, 160)}`);

    const process = await founder.post(`/api/wallet/payouts/${payoutId}/process`, { json: {} });
    check('an approved payout is sent to the provider as processing',
      process.status === 200 && process.data?.payout?.status === 'processing' &&
        process.data?.provider?.status === 'processing',
      `${process.status} ${JSON.stringify(process.data).slice(0, 240)}`);
    check('the provider created a transfer recipient for the seller', provider.state.recipients >= 1,
      `recipients=${provider.state.recipients}`);

    const payoutRef = process.data?.payout?.providerRef;
    const transferHook = await deliver({
      id: 'evt_staged_transfer_1',
      event: 'transfer.success',
      data: { reference: payoutRef, transfer_code: 'TRF_sim_1', status: 'success' },
    });
    check('a transfer webhook settles the payout as paid',
      transferHook.data?.outcome === 'payout_paid' &&
        db.prepare('SELECT status FROM payout_requests WHERE id = ?').get(payoutId)?.status === 'paid',
      `${transferHook.status} ${JSON.stringify(transferHook.data)}`);
    check('a paid payout leaves no reversal behind',
      ledger.sellerAvailable(sellerUser.id) === 0 && ledger.keyCount(`payout:${payoutId}:release`) === 0,
      `available=${ledger.sellerAvailable(sellerUser.id)} reversals=${ledger.keyCount(`payout:${payoutId}:release`)}`);

    /* ------------- a failed transfer must return the held funds ---------- */

    const listingD = await createListing(seller, 5000, 'Stage D failed transfer order');
    const orderD = await createOrder(buyer, listingD.id, 'staged-failed-transfer-1');
    const idD = orderD.data.order.id;
    await buyer.post(`/api/market/orders/${idD}/pay`, { json: {} });
    const refD = db.prepare('SELECT provider_ref FROM orders WHERE id = ?').get(idD)?.provider_ref;
    await buyer.get(`/api/market/payments/verify?reference=${encodeURIComponent(refD)}`);
    await buyer.post(`/api/market/orders/${idD}/status`, { json: { status: 'completed' } });
    const payoutD = await seller.post('/api/wallet/payouts', {
      json: { amountMinor: 485000, idempotencyKey: 'staged-payout-key-2' },
    });
    const payoutDId = payoutD.data?.payout?.id;
    await founder.post(`/api/wallet/payouts/${payoutDId}/review`, { json: { decision: 'approve', note: 'Approved' } });
    const processD = await founder.post(`/api/wallet/payouts/${payoutDId}/process`, { json: {} });
    check('a second payout reaches processing', processD.status === 200 && processD.data?.payout?.status === 'processing',
      `${processD.status} ${JSON.stringify(processD.data).slice(0, 160)}`);

    const failHook = await deliver({
      id: 'evt_staged_transfer_failed_1',
      event: 'transfer.failed',
      data: { reference: processD.data?.payout?.providerRef, status: 'failed', reason: 'Simulated bank rejection' },
    });
    check('a failed transfer marks the payout failed',
      failHook.data?.outcome === 'payout_failed' &&
        db.prepare('SELECT status FROM payout_requests WHERE id = ?').get(payoutDId)?.status === 'failed',
      `${failHook.status} ${JSON.stringify(failHook.data)}`);
    check('a failed transfer returns the held funds to the seller',
      ledger.sellerAvailable(sellerUser.id) === 485000 &&
        ledger.keyCount(`payout:${payoutDId}:release`) === 1,
      `available=${ledger.sellerAvailable(sellerUser.id)} reversals=${ledger.keyCount(`payout:${payoutDId}:release`)}`);

    /* ---------------------------- ledger integrity ----------------------- */

    const ledgerWrite = await seller.post('/api/wallet/ledger', { json: { amountMinor: 100000 } });
    check('no endpoint lets a client write to the ledger', ledgerWrite.status === 404,
      `${ledgerWrite.status} ${JSON.stringify(ledgerWrite.data)}`);
    const cancelOwn = await seller.post(`/api/wallet/payouts/${payoutDId}/cancel`, { json: {} });
    check('a failed payout cannot be cancelled back into a hold',
      cancelOwn.status === 409, `${cancelOwn.status} ${JSON.stringify(cancelOwn.data)}`);
    const strangerCancel = await stranger.post(`/api/wallet/payouts/${payoutId}/cancel`, { json: {} });
    check("an unrelated user cannot cancel someone else's payout", strangerCancel.status === 403,
      `${strangerCancel.status} ${JSON.stringify(strangerCancel.data)}`);

    const finalSeller = ledger.sellerAvailable(sellerUser.id) + ledger.sellerPending(sellerUser.id);
    check('the seller balance equals the one unreversed sale', finalSeller === 485000,
      `total=${finalSeller}`);
    check('the platform kept only the commission of the completed sale', ledger.platformAvailable() === 15000,
      `platform=${ledger.platformAvailable()}`);
    check('the buyer was never credited', ledger.sellerAvailable(buyerUser.id) === 0,
      `buyer available=${ledger.sellerAvailable(buyerUser.id)}`);
  } finally {
    if (db) db.close();
    await stopServer(server.child);
    if (failures) console.log(server.log().split('\n').slice(-40).join('\n'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// The unconfigured boot asserts the secret is absent too; keep the shape uniform.
function overviewSafe(overview) {
  return overview;
}

async function main() {
  console.log('Stage D — Paystack, wallet ledger, refunds and payouts\n');
  await runUnconfigured();
  const provider = await startFakeProvider(PROVIDER_PORT);
  try {
    await runConfigured(provider);
  } finally {
    await provider.stop();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nStage D suite crashed:', err);
  process.exitCode = 1;
});
