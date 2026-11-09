# Security model

What is enforced in code, and where the boundaries are.

## Authentication

* **Passwords** — `scrypt` (N=16384, r=8, p=1, 32-byte key) with a per-user random salt, stored as
  `scrypt$N$r$p$salt$key`. Verification uses `crypto.timingSafeEqual`.
* **Sessions** — a 32-byte random token is sent in an `httpOnly`, `SameSite=Lax`, `Secure` cookie
  (Secure is relaxed only when `FORCE_INSECURE_COOKIES=1` for local HTTP). Only the SHA-256 of the
  token is stored in `sessions`, so a database leak does not hand over live sessions. Sessions
  expire and are deleted on logout.
* **CSRF** — double-submit: the session issues a random `ash_csrf` cookie plus a matching
  `x-csrf-token` header requirement on every state-changing request. Unauthenticated endpoints
  (login/register/reset) are protected by rate limits instead.
* **Rate limiting** — per-IP, per-route windows on login, registration, password reset, AI calls,
  uploads and message sends. Failures return `429` with a retry hint.
* **Enumeration resistance** — password reset returns an identical body whether or not the address
  exists, and login failures do not distinguish "no such user" from "wrong password".

## Authorization

* Ownership checks run before every write (`author_id`, `owner_id`, `seller_id`, `buyer_id`).
* Post visibility is one SQL predicate (`postVisibility`) covering audience, friendship and blocks,
  used by feed, profile and single-post reads so no endpoint can drift.
* Media is **never** served statically. `/api/media/:id` resolves the row and applies the same
  visibility rules; the file path on disk is never exposed.
* Blocking is symmetric for reads: content disappears in both directions.
* Roles: `member` → `moderator` → `admin` → `founder`. Admin powers are the explicit strings in
  `users.permissions`; an admin without a permission is refused, and no permission grants Founder
  authority. A partial unique index enforces at most one Founder row, and `FOUNDER_EMAIL` binds it
  once at startup.
* Every privileged action writes to `audit_logs` (actor, action, target, metadata, IP).

## End-to-end encryption (private messages)

Implemented in `client/src/crypto.js`; the server only stores the envelope.

```
device keypair      ECDH P-256, non-extractable, kept in IndexedDB
per-message key     HKDF-SHA256( ECDH(myPriv, peerPub), salt = 16 random bytes )
ciphertext          AES-256-GCM, 12-byte random IV, per message
stored envelope     { v, iv, ct, salt, pub }   ← all the server ever sees
attachments         own AES-256-GCM key, which travels inside the encrypted payload
```

Because the private key never leaves the device and the server has neither half of the shared
secret, relays and servers cannot read message bodies or attachment bytes. The UI states the
remaining limits rather than implying more:

* This is **static ECDH**, not a double ratchet: no per-message forward secrecy, so compromise of a
  long-term device key exposes past messages from that conversation.
* **Metadata is not hidden** — participants, timestamps, message sizes and counts are visible to
  the server, as they must be to route and sync.
* **Safety numbers / key verification UI are not implemented**, so a malicious server could in
  principle substitute a public key on first contact. A full Signal-style protocol with
  pre-keys, ratcheting and verified safety numbers is the next cryptographic milestone.
* #ash AI never receives message content automatically. The assistant only sees text a user
  explicitly pastes or types into the AI screen.

## Data handling

* Input validation and normalisation on every route; JSON body limit 1 MB; upload size and MIME
  allow-lists, with 3D files restricted to `.glb`/`.gltf`.
* Secrets (`GROQ_API_KEY`, `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`, Supabase service role) are read
  from the environment on the server only and are never bundled into the client.
* Security headers: CSP (`default-src 'self'`, no inline scripts), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a scoped `Permissions-Policy`,
  and HSTS on HTTPS requests.
* Payment webhooks verify the provider signature against the raw body before trusting a status.

## Supabase RLS

`supabase/migrations/0002_rls.sql` enables RLS on all 22 app tables with a deny-by-default posture:

* No policy at all for `sessions`, `password_resets`, `audit_logs`, `transactions` — service role
  only.
* Self-service policies for profiles, likes, comments, friendships, notifications, consents.
* Visibility policies for posts (audience + friendship + blocks) and listings.
* Conversation members can read envelopes but never decrypt them; inserts are restricted to the
  sender inside a conversation they belong to.
* `users` UPDATE policy pins `role`, `is_founder` and `is_verified_seller` to their current values,
  so a client cannot self-escalate even with a valid session.
* Order inserts must satisfy `commission_minor + payout_minor = amount_minor` and
  `commission_minor > 0`, so a client cannot zero out the platform commission.

**Not yet executed.** These policies are written and reviewed but have not been applied to the TEST
project from this environment (no credentials). Apply and test them per `docs/DEPLOYMENT.md` before
relying on them.

## Reporting a vulnerability

Contact the Founder directly. Do not open a public issue for an unpatched vulnerability.
