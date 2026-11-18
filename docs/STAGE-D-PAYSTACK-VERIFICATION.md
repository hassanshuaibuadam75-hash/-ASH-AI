# Stage D — Paystack verification boundary

This document records exactly what has been proven about the payment integration, and
what has **not**. It exists so nobody later mistakes a simulated provider for a verified
one.

Environment: **TEST only**. No LIVE credentials, no LIVE Supabase, no real money, no
real transfers. Nothing in this document is evidence of a real Paystack transaction.

## How the integration is structured

| File | Responsibility |
| --- | --- |
| `server/paystack.js` | Provider client: base URL selection, live-key guard, `initializeTransaction`, `verifyTransaction`, `refundTransaction`, `listBanks`, `resolveAccountNumber`, webhook HMAC-SHA512 verification. |
| `server/wallet.js` | Immutable ledger (`wallet_entries`), platform balance, idempotency keys. |
| `server/routes-wallet.js` | Wallet reads, seller bank details, payout requests and state transitions, refunds. |
| `server/routes-market.js` | Checkout, provider webhook, order completion, server-side commission. |
| `server/index.js` | `completeOrder` — releases seller share + commission exactly once. |

## Operations exercised — against a LOCAL SIMULATED provider

`tests/wallet-ledger.test.mjs` boots the real server and a local HTTP server on
`127.0.0.1` that speaks Paystack-shaped JSON. The real integration code path runs end to
end (request building, signature checks, amount comparison, ledger writes), but the peer
is a simulation, not Paystack.

- Payment initialisation request/response handling (order → provider reference).
- Transaction verification: exact amount, currency, reference and status matching.
- Signed webhook delivery (`x-paystack-signature`, HMAC-SHA512).
- Replayed/duplicate webhook delivery ignored (idempotency).
- Forged signature rejected.
- Under-payment event credits nothing.
- Provider-confirmed refund reversing seller share and commission.
- Over-refund and repeat refund refused.
- Transfer-recipient creation for payouts (simulated).
- Payout state machine: pending → under review → approved → processing → paid/failed.
- Failed transfer returning held funds instead of losing them.

Result: **71/71 checks pass** (`node tests/wallet-ledger.test.mjs`).

## Operations exercised — unconfigured provider (honest failure paths)

With no `PAYSTACK_SECRET_KEY` present, these were verified to fail closed rather than
pretend to work:

- Payment initialisation returns `503` with a clear "provider not configured" reason.
- Provider verification and webhooks return `503`.
- A saved bank account stays `unverified`.
- Payouts are blocked with an explicit reason.

## NOT verified against real Paystack

These require TEST-mode credentials and/or provider account approval. They are
**unverified**, not "working":

1. Real `POST /transaction/initialize` response (shape, access code, authorization URL).
2. Real `GET /transaction/verify/:reference` against a Paystack-hosted test checkout.
3. Real webhook delivery from Paystack's servers, including their exact signature header
   and retry behaviour.
4. Real `GET /bank` list and `GET /bank/resolve` account-name resolution.
5. Real transfer recipient creation and real payout transfers.
6. Real refunds through the provider.
7. **Dedicated virtual accounts** — not implemented at all. They require an approved
   Paystack business account and provider configuration. No virtual account numbers are
   invented anywhere in this codebase.
8. Live-mode behaviour. `server/paystack.js` deliberately refuses live keys outside an
   explicitly allowed environment, so live operation has never been exercised.

## To close this boundary

Add these in Settings → Environment variables using **test-mode** values:

- `PAYSTACK_PUBLIC_KEY`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_WEBHOOK_SECRET`

Then re-run `node tests/wallet-ledger.test.mjs` (unit-level invariants stay valid) and
perform one manual TEST-mode checkout end to end, comparing the provider dashboard
transaction against the local order and ledger rows. Until that is done, the provider
column in the Stage D report remains "unverified against Paystack".
