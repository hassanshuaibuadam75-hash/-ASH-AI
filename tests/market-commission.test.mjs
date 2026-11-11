// #ash Mesh — Stage B: marketplace commission and integrity.
//
// Boots the REAL server against an isolated temporary data directory and proves:
//
//   every approved commission boundary (₦1 ... ₦10,000,001) is priced server-side
//   the band above ₦10,000,000 has NO rate: the order is held for Founder review,
//     never charged, and cannot be paid or released automatically
//   a client-supplied amount is rejected and audited; a client-supplied commission
//     or rate is ignored
//   a repeated idempotency key returns the original order instead of a second charge
//   only the Founder can review a held order, and a review note is mandatory
//   the audit trail records creation, hold, tamper rejection and review decisions
//
//   node tests/market-commission.test.mjs
//
// Nothing here touches the LIVE deployment, the real data directory or Supabase.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-stageb-'));
const DB_PATH = path.join(DATA_DIR, 'ash-mesh.db');
const FOUNDER_EMAIL = 'founder@ashmesh.test';
const FOUNDER_PASSWORD = 'FounderPass123';

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ↳ ${detail}`}`);
  return ok;
}

/* ------------------------------- http client ------------------------------ */

function makeClient() {
  const cookies = new Map();
  async function request(method, pathname, { json, form, headers = {} } = {}) {
    const h = { ...headers };
    if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = cookies.get('ash_csrf');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    let body;
    if (form) body = form;
    else if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(BASE + pathname, { method, headers: h, body });
    for (const cookie of res.headers.getSetCookie?.() || []) {
      const pair = cookie.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }
  return { get: (p, o) => request('GET', p, o), post: (p, o) => request('POST', p, o) };
}

/* ------------------------------- server boot ------------------------------ */

async function waitReady() {
  for (let i = 0; i < 160; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`);
      if (res.status < 500) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

/* --------------------------- approved boundaries --------------------------
   These expectations are written out independently of the implementation so the
   test fails if a rate is ever changed without authorisation.                  */
const BOUNDARIES = [
  { naira: 1, rate: 0.03, commissionMinor: 3, status: 'pending_payment' },
  { naira: 100000, rate: 0.03, commissionMinor: 300000, status: 'pending_payment' },
  { naira: 100001, rate: 0.05, commissionMinor: 500005, status: 'pending_payment' },
  { naira: 500000, rate: 0.05, commissionMinor: 2500000, status: 'pending_payment' },
  { naira: 500001, rate: 0.03, commissionMinor: 1500003, status: 'pending_payment' },
  { naira: 1000000, rate: 0.03, commissionMinor: 3000000, status: 'pending_payment' },
  { naira: 1000001, rate: 0.025, commissionMinor: 2500003, status: 'pending_payment' },
  { naira: 5000000, rate: 0.025, commissionMinor: 12500000, status: 'pending_payment' },
  { naira: 5000001, rate: 0.02, commissionMinor: 10000002, status: 'pending_payment' },
  { naira: 10000000, rate: 0.02, commissionMinor: 20000000, status: 'pending_payment' },
  { naira: 10000001, rate: null, commissionMinor: null, status: 'held_founder_review' },
];

async function main() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      DB_PATH,
      FORCE_INSECURE_COOKIES: '1',
      FOUNDER_EMAIL,
      FOUNDER_PASSWORD,
      GROQ_API_KEY: '',
      PAYSTACK_SECRET_KEY: '',
      RESEND_API_KEY: '',
      BACKUP_SCHEDULER: 'off',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    await waitReady();

    const seller = makeClient();
    const buyer = makeClient();
    const founder = makeClient();

    const regSeller = await seller.post('/api/auth/register', {
      json: { fullName: 'Stage B Seller', username: 'stagebseller', password: 'SellerPass123', email: 'seller@stageb.test' },
    });
    check('seller account registers', regSeller.status === 201, `${regSeller.status} ${JSON.stringify(regSeller.data).slice(0, 160)}`);
    const regBuyer = await buyer.post('/api/auth/register', {
      json: { fullName: 'Stage B Buyer', username: 'stagebbuyer', password: 'BuyerPass123', email: 'buyer@stageb.test' },
    });
    check('buyer account registers', regBuyer.status === 201, `${regBuyer.status} ${JSON.stringify(regBuyer.data).slice(0, 160)}`);
    const founderLogin = await founder.post('/api/auth/login', { json: { email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD } });
    check('founder signs in with Founder authority', founderLogin.status === 200 && founderLogin.data?.user?.isFounder === true,
      `${founderLogin.status} ${JSON.stringify(founderLogin.data?.user || founderLogin.data).slice(0, 160)}`);

    async function createListing(priceNaira, title) {
      const form = new FormData();
      form.set('title', title);
      form.set('description', 'Stage B commission integrity listing.');
      form.set('category', 'general');
      form.set('location', 'Kano');
      form.set('price', String(priceNaira));
      const res = await seller.post('/api/market/listings', { form });
      if (res.status !== 201) throw new Error(`listing create failed ${res.status} ${JSON.stringify(res.data)}`);
      return res.data.listing;
    }

    /* ------------------- every approved boundary, server-side ------------------ */

    const heldOrderIds = [];
    for (const band of BOUNDARIES) {
      const listing = await createListing(band.naira, `Boundary ₦${band.naira}`);
      const res = await buyer.post(`/api/market/listings/${listing.id}/orders`, {
        json: { deliveryNote: `Stage B boundary ₦${band.naira}` },
        headers: { 'Idempotency-Key': `stageb-boundary-${band.naira}` },
      });
      const order = res.data?.order;
      if (!check(`₦${band.naira}: order created`, res.status === 201 && !!order, `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`)) continue;

      if (band.status === 'held_founder_review') {
        check(`₦${band.naira}: held for Founder review, no rate applied`,
          order.status === 'held_founder_review' && order.commissionRate === null && order.commissionHeld === true,
          `status=${order.status} rate=${order.commissionRate} held=${order.commissionHeld}`);
        check(`₦${band.naira}: no payment was initialized`,
          res.data.payment?.status === 'held_founder_review' && !order.providerRef,
          `payment=${JSON.stringify(res.data.payment)} ref=${order.providerRef}`);
        heldOrderIds.push(order.id);
        continue;
      }

      check(`₦${band.naira}: commission ${band.commissionMinor} kobo`,
        order.commissionMinor === band.commissionMinor, `expected ${band.commissionMinor}, got ${order.commissionMinor}`);
      check(`₦${band.naira}: approved rate ${band.rate * 100}%`,
        order.commissionRate === band.rate, `expected ${band.rate}, got ${order.commissionRate}`);
      check(`₦${band.naira}: seller payout is amount minus commission`,
        order.payoutMinor === listing.priceMinor - band.commissionMinor,
        `expected ${listing.priceMinor - band.commissionMinor}, got ${order.payoutMinor}`);
      check(`₦${band.naira}: awaiting payment`, order.status === 'pending_payment', `status=${order.status}`);
    }

    /* ----------------------- published commission structure -------------------- */

    const browse = await buyer.get('/api/market/listings?limit=1');
    const rates = (browse.data?.commissionTiers || []).map((t) => t.rate);
    check('approved commission table is unchanged in the API',
      JSON.stringify(rates) === JSON.stringify([0.03, 0.05, 0.03, 0.025, 0.02]), JSON.stringify(rates));
    check('the >₦10,000,000 band is published as Founder review, with no rate',
      browse.data?.founderReviewBand?.above === 10000000 && browse.data.founderReviewBand.rate === null,
      JSON.stringify(browse.data?.founderReviewBand));

    /* ----------------------------- client tampering ---------------------------- */

    const tamperListing = await createListing(5000, 'Tamper target');
    const tampered = await buyer.post(`/api/market/listings/${tamperListing.id}/orders`, { json: { amountMinor: 100 } });
    check('a client-supplied amount is rejected', tampered.status === 400, `${tampered.status} ${JSON.stringify(tampered.data)}`);

    const feeListing = await createListing(2000, 'Fee tamper target');
    const feeTamper = await buyer.post(`/api/market/listings/${feeListing.id}/orders`, {
      json: { amountMinor: feeListing.priceMinor, commissionMinor: 1, commissionRate: 0.0001, payoutMinor: feeListing.priceMinor - 1 },
      headers: { 'Idempotency-Key': 'stageb-fee-tamper' },
    });
    check('client-supplied commission and payout are ignored',
      feeTamper.status === 201 && feeTamper.data?.order?.commissionMinor === 6000 && feeTamper.data.order.commissionRate === 0.03,
      `${feeTamper.status} commission=${feeTamper.data?.order?.commissionMinor} rate=${feeTamper.data?.order?.commissionRate}`);

    /* -------------------------------- idempotency ------------------------------ */

    const idemListing = await createListing(3000, 'Idempotency target');
    const first = await buyer.post(`/api/market/listings/${idemListing.id}/orders`, {
      json: {}, headers: { 'Idempotency-Key': 'stageb-idempotent-1' },
    });
    const second = await buyer.post(`/api/market/listings/${idemListing.id}/orders`, {
      json: {}, headers: { 'Idempotency-Key': 'stageb-idempotent-1' },
    });
    check('the first idempotent order is created', first.status === 201 && !!first.data?.order, `${first.status}`);
    check('a repeated idempotency key returns the same order, not a second charge',
      second.status === 200 && second.data?.idempotentReplay === true && second.data?.order?.id === first.data?.order?.id,
      `${second.status} ${JSON.stringify(second.data).slice(0, 200)}`);

    /* ------------------------- held order cannot be paid ----------------------- */

    // A second held order, so the rejection path is exercised independently.
    const secondHeldListing = await createListing(12000000, 'Boundary ₦12,000,000');
    const secondHeldRes = await buyer.post(`/api/market/listings/${secondHeldListing.id}/orders`, {
      json: {}, headers: { 'Idempotency-Key': 'stageb-held-second' },
    });
    check('a second order above ₦10,000,000 is also held',
      secondHeldRes.status === 201 && secondHeldRes.data?.order?.status === 'held_founder_review',
      `${secondHeldRes.status} ${secondHeldRes.data?.order?.status}`);
    if (secondHeldRes.data?.order?.id) heldOrderIds.push(secondHeldRes.data.order.id);

    const heldId = heldOrderIds[0];
    if (heldId) {
      const payAttempt = await buyer.post(`/api/market/orders/${heldId}/pay`, { json: {} });
      check('a held order cannot be sent for payment', payAttempt.status === 400, `${payAttempt.status} ${JSON.stringify(payAttempt.data)}`);

      const nonFounderReview = await buyer.post(`/api/market/orders/${heldId}/review`, { json: { decision: 'approve', note: 'buyer self-approval' } });
      check('a non-Founder cannot release a held order', nonFounderReview.status === 403, `${nonFounderReview.status}`);

      const sellerReview = await seller.post(`/api/market/orders/${heldId}/review`, { json: { decision: 'approve', note: 'seller self-approval' } });
      check('a seller cannot release a held order', sellerReview.status === 403, `${sellerReview.status}`);

      const noNote = await founder.post(`/api/market/orders/${heldId}/review`, { json: { decision: 'approve' } });
      check('releasing a held order requires a recorded reason', noNote.status === 400, `${noNote.status}`);

      const heldList = await founder.get('/api/market/held-orders');
      check('the Founder can list held orders', heldList.status === 200 && heldList.data.orders.some((o) => o.id === heldId),
        `${heldList.status}`);

      const approved = await founder.post(`/api/market/orders/${heldId}/review`, { json: { decision: 'approve', note: 'Agreed 2% for this order' } });
      check('the Founder releases the held order to payment without charging it',
        approved.status === 200 && approved.data?.order?.status === 'pending_payment' && approved.data.order.reviewNote.includes('Agreed'),
        `${approved.status} ${JSON.stringify(approved.data?.order?.status)}`);

      const secondHeld = heldOrderIds[1];
      if (secondHeld) {
        const rejected = await founder.post(`/api/market/orders/${secondHeld}/review`, { json: { decision: 'reject', note: 'Price not approved' } });
        check('the Founder can reject a held order', rejected.status === 200 && rejected.data?.order?.status === 'rejected', `${rejected.status}`);
      }
    }

    /* ------------------------------ audit evidence ----------------------------- */

    const db = new Database(DB_PATH, { readonly: true });
    const auditTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%audit%'").get()?.name;
    const auditRows = auditTable ? db.prepare(`SELECT * FROM ${auditTable}`).all() : [];
    const audited = (action) => auditRows.some((row) => JSON.stringify(row).includes(action));
    check('order creation is audited', audited('order.create'), `table=${auditTable} rows=${auditRows.length}`);
    check('the Founder hold is audited', audited('order.held_founder_review'));
    check('the tamper attempt is audited', audited('order.tamper_rejected'));
    check('the Founder release is audited', audited('order.review_approved'));
    check('the Founder rejection is audited', audited('order.review_rejected'));

    const idemOrders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?').get('stageb-idempotent-1').n;
    check('exactly one order exists for a repeated idempotency key', idemOrders === 1, `count=${idemOrders}`);

    const heldRow = db.prepare('SELECT status, commission_rate, commission_minor FROM orders WHERE id = ?').get(heldOrderIds[1] || heldOrderIds[0]);
    check('no held order ever stored an unauthorised rate',
      heldRow && heldRow.commission_rate === 0 && heldRow.commission_minor === 0,
      JSON.stringify(heldRow));

    db.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (failures) {
      console.log('\n--- server log (tail) ---');
      console.log(serverLog.split('\n').slice(-40).join('\n'));
    }
  }

  console.log(`\nStage B commission/integrity: ${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('Stage B test crashed:', err);
  process.exit(1);
});
