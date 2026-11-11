# Feature status

Honest separation, as required. Nothing here is marked "done" without evidence.

## 1. Completed and verified (automated suite, 59/59)

* Registration, login, logout, session handling, password reset request/confirm
* Profile read/update, per-field privacy, avatar and cover upload
* Posts: text/image/video/3D, audience selection, likes, comments, shares, edit, delete, reports
* Friends: search, request, accept, reject, cancel, remove, block
* Notifications with read state
* Messaging: conversations, E2E envelope storage, delivery/read status, attachment messages,
  offline outbox with de-duplication
* Marketplace: listings, search, orders, commission tiers, seller verification requests
* 3D upload validation and media serving
* Founder Dashboard counts; non-Founder access denied
* Admin: permission-gated moderation, report handling, audit log
* UAR network reporting and relay consent
* CSRF rejection, login rate limiting, media access control

## 2. Implemented, not verifiable in this environment

| Feature | Why not verified | How to verify |
| --- | --- | --- |
| Wi-Fi Aware (NAN) transport | native source only, no Android SDK/device | build APK, two NAN-capable phones, `native/README.md` |
| Wi-Fi Direct transport | same | same, larger file transfer |
| Bluetooth LE discovery/small frames | same | same, with BLE-only devices |
| Native offline store wiring | depends on the above | same |
| Supabase RLS policies | no Supabase credentials here | apply to TEST project, run policy checks in `docs/DEPLOYMENT.md` |
| Password reset email delivery | needs `RESEND_API_KEY` | set key, request reset, check inbox |
| Payment capture and webhook | needs Paystack keys + public URL | set keys, buy a listing in test mode |

## 3. Requires an external service, hardware or your authorization

* **Paystack (or another provider) merchant account** — real money movement, commission settlement
  and refunds. The adapter is written; keys are not.
* **Groq API key** — #ash AI replies, translation, captions. Without it the UI says "not
  configured" rather than faking output.
* **Resend (or SMTP) key** — transactional email for password recovery.
* **Supabase TEST project credentials** — to apply `supabase/migrations/`. The LIVE project
  (`zwfleqgmamohxxzjwkaf`) must not be touched without your explicit authorization.
* **LoRa gateway hardware** — optional Layer 5. Capability is reported only after a user pairs a
  gateway; nothing else depends on it.
* **Android signing keystore** — needed for a Play Store build, not for local testing.

## 4. Deliberately not built

* #ash Jobs, #ash Skills, #ash Connect, #ash Games, #ash Creative — excluded by instruction.
* No fake posts, users, transactions or sample marketplace items exist anywhere in the codebase.

## 5. Known limitations to decide on

1. **Storage durability on the Free hosting plan.** SQLite and uploads live on the container
   filesystem. Free hosting has no persistent disk, so a redeploy resets data. Options: upgrade to
   Starter for a persistent disk, or fund a Postgres/Supabase-backed data layer (schema and RLS
   already exist; the adapter is not written).
2. **Single-node messaging.** Delivery status is database-backed; realtime push uses polling.
   WebSocket fan-out would need a multi-instance-safe design.
3. **E2E scope.** Message bodies and attachment bytes are encrypted client-side; metadata
   (participants, timestamps, sizes) is necessarily visible to the server. Group key rotation and
   verified safety numbers are not implemented.
4. **Moderation at scale.** Reports and admin actions are manual; no automated classifier runs
   over user content.

## Data durability and recovery

- Automatic snapshots (`VACUUM INTO`) with checksum sidecars, integrity verification and
  retention — implemented and verified.
- Founder-only list / create / verify / download / restore / restore-from-upload / ZIP export
  (snapshot + all uploads), all audited and rate limited — implemented and verified.
- Founder Dashboard → **Data & Backups** panel with two-step restore confirmation —
  implemented.
- Restore is transactional and takes a pre-restore safety snapshot; it rolls back with a clear
  reason instead of damaging data — verified.
- Off-platform durability on the Free plan is a manual download: no persistent disk and no
  external backup provider is configured. See `docs/BACKUP.md`.
