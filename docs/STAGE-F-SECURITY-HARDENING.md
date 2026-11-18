# Stage F — Security Hardening Report

Environment: **TEST only.** No LIVE Supabase access, no LIVE deployment, no rebuild, no
purchases. Git commit: `2904259dbe83be3b2b0e6d3b5c763ad073655f6f`.

Status legend: **Verified** = implementation exists and a test proved it. **Implemented —
configuration required** = code is real but needs an external credential. **Not verified** =
no test yet. **Not implemented** = does not exist.

---

## 1. Critical finding: Founder takeover through registration (FIXED, VERIFIED)

`server/routes-auth.js` inserted any account that registered the configured `FOUNDER_EMAIL`
with `role = 'founder', is_founder = 1`. The password was whatever the registrant chose.

Consequences: anyone who knew or guessed the Founder email could create (or pre-create on a
fresh container) the Founder account and obtain Founder-only authority — Founder Dashboard,
Founder Editor, wallet/payout approval, backup export/restore, commission control.

Fix: registration now refuses the configured Founder address with the same `409 email_taken`
response used for any taken address, so the refusal leaks nothing. Founder authority can only
come from boot provisioning with the configured credential (`ensureFounderAccount`), never from
a public endpoint.

Verified by 5 checks: refusal, indistinguishable response, attacker password never binds to the
Founder row, the configured Founder still signs in, and the signed-in Founder still holds
authority and can open the dashboard.

## 2. Boot provisioning cannot promote a stranger (FIXED, VERIFIED)

`ensureFounderAccount` promoted *any* existing row whose email matched `FOUNDER_EMAIL`,
regardless of a configured password. Pointing the variable at an ordinary member's address
silently granted that member Founder authority.

Fix: an existing non-founder row is promoted only when `FOUNDER_PASSWORD` is configured, the
stored hash matches it, or the row has no usable password; otherwise it is left untouched and a
warning is logged. A rotated `FOUNDER_PASSWORD` still takes effect for the genuine Founder row.

Verified: an ordinary member registered first, the server restarted with `FOUNDER_EMAIL` pointed
at that address and no password — the account signs in normally, `isFounder === false`, and the
Founder dashboard returns `403`.

## 3. Sessions survive a password change (FIXED, VERIFIED)

Changing a password left every other session valid, so a stolen session outlived the
remediation the user performed in response to a compromise.

Fix: `PUT /api/auth/password` deletes all other sessions for that user and keeps the current
device signed in.

Verified: a second device is signed out by the password change while the changing device stays
signed in.

## 4. Stale permission grants on demoted members (FIXED, VERIFIED)

`requirePermission` (`server/lib.js`) and `anyPermission` (`server/routes-admin.js`) honoured a
permission grant without checking that the account still held an elevated role. A member demoted
from `admin` kept every granted capability, including moderation and user management.

Fix: both helpers now require `role IN ('admin','moderator')` before a grant counts. A stale
grant on a demoted member is inert.

Verified: a demoted member loses admin access, while a genuine admin grant still works — the
check is present to prove the gate did not over-tighten legitimate administration.

## 5. Founder authority is not reassignable (VERIFIED)

`POST /api/admin/users/:id/role` refuses `role: 'founder'`, including when the Founder himself
makes the request, and a member cannot grant themselves the Founder role (`403`). Founder
identity stays bound to the server-side row and configured credential.

## 6. Wallet, ledger, webhook and payout authorization (REVIEWED, VERIFIED)

Reviewed `server/wallet.js`, `server/routes-wallet.js`, `server/routes-market.js`,
`server/paystack.js`. No privilege or integrity defect found in this pass; the invariants are
already enforced and covered by the 71-check wallet/ledger suite:

- Every balance movement is a ledger entry written server-side; no endpoint accepts a
  client-supplied balance or ledger row.
- Sale credits are idempotent per order — repeated provider verification does not double-credit.
- Webhooks require a valid signature; forged signatures are rejected, replays are recognised as
  duplicates and change no balance, and a short payment is not accepted as paid.
- Refunds cannot exceed the order, cannot be issued by an unrelated user, reverse both the seller
  share and the commission, and cannot be repeated once complete.
- Payouts: a non-Founder cannot approve, a seller cannot approve their own, funds leave
  `available` on request, an idempotency key returns the original payout, and a failed transfer
  returns the held funds.
- The approved commission tiers (3/5/3/2.5/2 %, >₦10m held for Founder review) are unchanged and
  calculated server-side.

Provider-dependent behaviour is stub-tested only — see `docs/STAGE-D-PAYSTACK-VERIFICATION.md`.

## 7. API and data-exposure review (VERIFIED)

- CSRF is required on state-changing requests; a missing token is refused.
- Login is rate limited; repeated failures are throttled.
- No password hash, salt or session token appears in any API response.
- Bank account numbers are never returned in full; the provider secret never reaches a client.
- Archive responses never expose credentials or filesystem paths; zip-slip entries are refused
  and write nothing outside the media directory.
- Uploads are validated by content, not by client-declared type.

## 8. End-to-end encryption review

See `docs/SECURITY-E2EE-REVIEW.md`. Current design: ECDH P-256 (non-extractable browser keys) →
HKDF → AES-GCM. The server stores ciphertext only.

**Honest limits:** no forward secrecy (a static key compromise decrypts past messages), no
sender authentication inside the envelope, no AAD binding to conversation/message identity, and
no safety-number/identity-verification UI. These are design-level gaps, not bugs — the protocol
is sound for its threat model but should not be described as Signal-equivalent.

Recommended v2, in order: (1) ephemeral-static ECDH per message with Ed25519 sender signatures
and AAD binding; (2) X3DH-style prekeys; (3) Double Ratchet for forward secrecy. Each needs a
compatibility window for existing envelopes. **Not implemented.**

## 9. React Router v7 migration (DONE, VERIFIED)

`react-router-dom` 6.30.6 → **7.18.5**, clearing GHSA-337j-9hxr-rhxg and GHSA-wrjc-x8rr-h8h6.
The application is declarative-mode only (`BrowserRouter`/`Routes`/`Route`/`Link`/`NavLink`), which
is source-compatible in v7, so no routing code changed. The production build succeeds (78
modules) and the full suite passes, so the upgrade is verified for this codebase. Data-router,
loader and middleware APIs were not adopted.

## 10. Dependency scan (current)

229 packages, OSV: **1 HIGH** — `picomatch@4.0.7`, GHSA-fc5q-39xc-vjpf (ReDoS via repeated
extglobs), **no fixed version published**. It is a dev-only transitive dependency of Vite's build
tooling, not shipped in the deployed bundle, and it processes build-time globs rather than
untrusted user input. Both React Router advisories are now cleared. This is recorded as a known,
unfixable-here finding rather than suppressed.

---

## Test evidence

`npm test && npm run build` — PASS at revision 69:

| Suite | Result |
|---|---|
| API end-to-end (`tests/run-tests.js`) | 113/113 |
| Offline feed (`tests/offline-feed.test.mjs`) | 11/11 |
| Moderation (`tests/moderation.test.mjs`) | PASS |
| Founder Editor (`tests/founder-editor.test.mjs`) | PASS |
| Founder Editor discoverability | PASS |
| Marketplace commission boundaries | PASS |
| Backup drill | PASS |
| Archive recovery drill | 54/54 |
| Wallet, ledger, refunds, payouts | 71/71 |
| Security hardening (new) | 26/26 |
| Production build | PASS (78 modules) |

The new `tests/security-hardening.test.mjs` is part of `npm test`, so every regression above is
now guarded.

## Files changed in Stage F

- `server/routes-auth.js` — registration cannot mint Founder authority; password change revokes
  other sessions.
- `server/lib.js` — guarded boot promotion; elevated-role gate in `requirePermission`.
- `server/routes-admin.js` — same gate in `anyPermission`.
- `package.json`, `package-lock.json` — React Router 7.18.5.
- `tests/security-hardening.test.mjs` — new 26-check suite.
- `tests/run-tests.js`, `tests/moderation.test.mjs`, `tests/founder-editor.test.mjs`,
  `tests/founder-editor-discoverability.test.mjs` — Founder bootstrap now provisions from
  configuration and signs in, matching the hardened rule.
- `docs/STAGE-D-PAYSTACK-VERIFICATION.md`, `docs/SECURITY-E2EE-REVIEW.md`,
  `docs/STAGE-F-SECURITY-HARDENING.md`.

## Not implemented / not verified

- E2EE forward secrecy, sender authentication, AAD binding and safety numbers (design work above).
- Rate limiting on every write endpoint: login, registration, AI and payment paths are limited;
  a per-account write budget across all social endpoints is **not** implemented.
- Paystack provider calls remain unverified against the real provider (no TEST keys configured).
- `picomatch` HIGH has no published fix; accepted and documented.
- Nothing was deployed or rebuilt, per the deployment restriction; the running app still serves
  the previous build.
- LIVE Supabase untouched; no purchases or upgrades.

## Stage A / B / C / D regression

Backup drill, archive recovery (54/54 including rollback and zip-slip), Founder Editor and
discoverability suites, commission boundary suite and the wallet ledger suite all still pass, so
Stage A–D behaviour is intact.
