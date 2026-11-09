# Testing report

Last full run: `npm test` → **59/59 checks passed** (`tests/run-tests.js`, isolated temp database).

## How the suite runs

`tests/run-tests.js` boots the real Express app on a random port with `DATA_DIR` pointed at a
temporary directory, then drives it over HTTP with a cookie jar — the same code paths a browser
uses. Every check asserts on database-visible behaviour, not on HTTP 200 alone. No rows are
pre-seeded; accounts are created through `/api/auth/register` and destroyed with the temp database.

Run it yourself:

```bash
npm test
```

## What is covered

| Area | Verified behaviour |
| --- | --- |
| Registration | creates account, rejects duplicate email/username, rejects weak passwords, hashes with scrypt |
| Login / logout | session cookie issued, `/api/auth/me` returns the user, logout invalidates the session |
| Password reset | request always answers identically (no account enumeration), token is single-use |
| CSRF | state-changing requests without the CSRF token are rejected |
| Rate limiting | repeated failed logins are throttled |
| Profiles | profile update persists, privacy settings respected for other viewers, hidden fields not leaked |
| Media | upload accepted with type/size validation, served only through `/api/media/:id`, unauthorised access denied |
| Posts | create with audience, feed visibility per audience, like/unlike idempotent, comment create, share, edit, soft delete |
| Post ownership | a non-author cannot edit or delete another user's post |
| Friends | request → accept, duplicate request rejected, cancel, remove, block hides content both ways |
| Notifications | created for friend requests/likes/comments, marked read |
| Messaging | conversation created, encrypted envelope stored and returned to members only, delivery status transitions, duplicate client id is de-duplicated |
| Conversation access | a non-member cannot read or post to a conversation |
| Marketplace | listing create/search, commission computed per tier, order created with commission + payout = amount, seller cannot buy own listing |
| Seller verification | request submitted, non-admin cannot approve |
| 3D | GLB upload accepted, wrong extension rejected |
| AI | without `GROQ_API_KEY` the endpoint reports "not configured" instead of inventing a reply |
| Founder/Admin | Founder dashboard counts, non-Founder denied Founder routes, permission-gated moderation, audit log written |
| UAR | network report recorded, relay consent stored and revocable |

## What the suite does **not** prove

Be explicit about the boundary:

1. **Native radio transports.** Wi-Fi Aware (NAN), Wi-Fi Direct and BLE code in `native/` is
   source only. There is no Android SDK or device in this environment, so it has not been
   compiled or exercised. Treat native behaviour as unverified until you build the APK and test
   on hardware (see `native/README.md`).
2. **Payment capture.** The Paystack adapter makes real provider calls only when
   `PAYSTACK_SECRET_KEY` is present. Without a key, orders stay `pending_payment`; no charge is
   simulated. Live capture needs your merchant keys and a webhook-reachable domain.
3. **Email delivery.** Without `RESEND_API_KEY`, reset links are written to the audit log for the
   operator instead of being emailed.
4. **AI replies.** Without `GROQ_API_KEY` the assistant returns a clear "not configured" state.
5. **Supabase RLS execution.** `supabase/migrations/*.sql` is written against the TEST project but
   has not been applied here — no Supabase credentials are available in this environment. The
   policies are reviewed by reading, not executed. Apply them to the TEST project and run the
   policy tests described in `docs/DEPLOYMENT.md` before trusting them.
6. **End-to-end encryption against a hostile server.** The ciphertext envelope is never decryptable
   server-side by design, and the API stores only the envelope, but a formal cryptographic audit
   (Signal-style double ratchet, key verification UI, forward secrecy across device compromise)
   has not been performed. See `docs/SECURITY.md` for the exact protocol and its limits.
7. **Load, soak and penetration testing.** Not performed. The hosting plan is 1 vCPU / 1 GB, so
   capacity numbers would be meaningless anyway.

## Bugs found and fixed during testing

* Test harness imported `db.js` from the wrong directory after the server was moved into
  `server/`, breaking module resolution — fixed by importing `../server/db.js`.
* Password-reset response differed between known and unknown addresses, leaking account
  existence — fixed so both paths return the same body and timing profile.

## Manual smoke test (browser)

1. Register at `/` → you land on the feed with an empty state (no fake posts).
2. Create a post with audience "Friends only" → it appears for you, not for a second account.
3. Like a post → count updates in place, scroll position is preserved.
4. Open the post menu → Delete → confirmation dialog → post disappears.
5. Send a message to a friend → status shows delivered; disable the network → message is queued
   and flushes automatically when connectivity returns.
6. Create a listing, buy it with a second account → order shows commission and seller payout.
7. Upload a `.glb` → viewer opens, drag to rotate, scroll to zoom.
