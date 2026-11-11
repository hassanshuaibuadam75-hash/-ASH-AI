# Deployment

## 1. Server (web app + API)

Requirements: Node.js 20 or newer (24 LTS recommended), and a writable data directory.

```bash
npm ci
npm run build          # builds client/dist
PORT=3000 DATA_DIR=/data npm start
```

The server listens on `$PORT` and serves both the API and the built client from one origin, so no
proxy configuration is needed. `npm test` must pass before you ship.

Environment variables (see `.env.example`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | yes (host provides) | HTTP port |
| `DATA_DIR` | strongly recommended | SQLite database + uploads. Point at a **persistent disk** |
| `FOUNDER_EMAIL` | for Founder access | binds Founder/CEO authority to that account |
| `GROQ_API_KEY` | optional | #ash AI; without it the UI reports "not configured" |
| `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` | optional | real payments; no charge is simulated |
| `PAYMENT_CALLBACK_URL` | with payments | public HTTPS webhook URL |
| `RESEND_API_KEY` / `MAIL_FROM` / `PUBLIC_APP_URL` | optional | password-reset email |
| `SUPABASE_TEST_*` | optional | only for the Supabase migrations tooling |
| `FORCE_INSECURE_COOKIES` | local dev only | `1` over plain HTTP |

### Storage durability — read this before real users

On the **Free** hosting plan there is no persistent disk. `DATA_DIR` lives on the container
filesystem, so **a redeploy resets accounts, posts, messages, orders and uploads**. Two supported
fixes:

1. Upgrade to **Starter ($5/month)** in Settings → Billing and mount a persistent disk at `DATA_DIR`.
2. Move the data layer to Postgres/Supabase. The schema and RLS already exist in
   `supabase/migrations/`; the Node adapter that talks to it is **not** written yet.

Do not advertise the deployment as durable until one of these is done.

### First-run checklist

1. Deploy, then open the app and register the Founder account through the UI.
2. Set `FOUNDER_EMAIL` to that address and redeploy → `/api/founder/*` becomes available to it.
3. Confirm `/api/health` returns `ok`.
4. Run `npm test` against the deployment's code revision.

## 2. Supabase — TEST project only

**TEST:** `https://wfnhlrwqwpiuqaamdbvz.supabase.co`
**LIVE:** `https://zwfleqgmamohxxzjwkaf.supabase.co` — **do not touch without the Founder's explicit
authorization.**

Apply the migrations to the TEST project:

```bash
psql "$SUPABASE_TEST_DB_URL" -f supabase/migrations/0001_schema.sql
psql "$SUPABASE_TEST_DB_URL" -f supabase/migrations/0002_rls.sql
```

Or paste each file into the TEST project's SQL editor, in order. `0001` creates the schema, the
single-Founder partial unique index, the order commission constraints and the private
`ashmesh-media` storage bucket; `0002` enables RLS with deny-by-default policies.

Verify the policies actually bite (run as the anon key, not service role):

```sql
-- must return 0 rows for a user who is not the owner / not a member
select * from public.messages limit 5;
select * from public.users where id <> auth.uid();
-- must fail: commission cannot be zeroed by a client
insert into public.orders (id, listing_id, buyer_id, seller_id, amount_minor, commission_minor,
                           commission_rate, payout_minor)
values ('t1', '<listing>', auth.uid(), '<seller>', 10000, 0, 0, 10000);
```

Keep the service role key server-side only. It must never appear in `client/` or any bundled file.

## 3. Android app (native radios)

See `native/README.md`. In short: build `client/dist`, `npx cap add android`, `npx cap sync`, copy
the Java sources into `android/app/src/main/java/com/ashmesh/app/`, then build in Android Studio.
The web app already detects the bridge and will report the device's real capabilities.

Native radio code is **unverified** until it is compiled and tested on hardware — no Android SDK or
device exists in this build environment.

## 4. Health and observability

* `GET /api/health` — liveness for the platform's health check.
* `audit_logs` — every privileged action with actor, target and IP.
* Founder Dashboard — user/post/message/market counts, system health, UAR and relay activity.
* The server logs which optional integrations are inactive at startup
  (`Payments: … not set`, `Email: … not set`, `AI: … not set`), so an operator can see at a glance
  what is real and what is not configured.

## 5. Backups

With a persistent disk: snapshot `DATA_DIR` (SQLite file plus `uploads/`). Use `sqlite3
ash-mesh.db ".backup out.db"` for a consistent copy while the server runs. Without a persistent
disk there is nothing durable to back up — fix storage first.

## Data durability (Stage A)

The database is one SQLite file (`DATA_DIR/ash-mesh.db`, WAL) and uploads live in
`DATA_DIR/uploads`. On the Free plan neither survives a redeploy, so durability depends on
off-platform archives.

- The server writes a snapshot at boot + interval and keeps the newest `BACKUP_RETENTION`
  (`VACUUM INTO`, so a live WAL database is copied consistently). Each snapshot has a sidecar
  with its sha256, row counts and integrity result.
- `GET /api/founder/export` returns one ZIP (snapshot + manifest + all uploads). **Download it
  before every deploy.** It is the only copy that survives a rebuild on this plan.
- Recovery: Founder Dashboard → Data & Backups → Restore, or "Restore from file" with the
  `.db` from an archive. A restore is transactional, takes a pre-restore safety snapshot and
  rolls back (HTTP 409) instead of damaging data.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_DIR` | `DATA_DIR/backups` | snapshot directory |
| `BACKUP_RETENTION` | `14` | newest N snapshots kept (2–60) |
| `BACKUP_INTERVAL_MINUTES` | `360` | scheduled interval (5–1440) |
| `BACKUP_INITIAL_DELAY_MS` | `15000` | first scheduled snapshot delay |
| `BACKUP_SCHEDULER` | on | `off` disables the scheduler |

Durable storage on the server itself needs a persistent disk (Starter/Pro). Full detail,
limitations and drill evidence: `docs/BACKUP.md`.
