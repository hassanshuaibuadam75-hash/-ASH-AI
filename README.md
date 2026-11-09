# #ash Mesh

**Your Network. Your Privacy. Your World.**
Phone to Phone, City to City, Without Stopping.

Founder & CEO: **Hassan Shuaibu Adam** · Official domain: **ashmesh.com**

#ash Mesh is a working social network and private messenger with a Universal Adaptive Routing
(UAR) engine: it sends over the internet when online, falls back to nearby device-to-device
radios in the native Android app, and queues messages in an encrypted on-device outbox when no
route exists.

This repository is the real application — server, database, security policies, React client and
native Android transport source. It is not a mockup.

---

## What runs here

| Layer | Technology | Notes |
| --- | --- | --- |
| API | Node.js 20+ / Express 4 | `server/` — auth, social, chat, market, admin, AI |
| Database | SQLite (WAL) via `better-sqlite3` | `server/schema.sql`, no seed rows ever inserted |
| Client | React 18 + Vite 5 + React Router 6 | `client/` — 12 screens, mobile-first |
| 3D | three.js GLTFLoader | GLB/glTF upload, rotate/zoom viewer |
| Native | Capacitor 6 + Java plugins | `native/` — Wi-Fi Aware, Wi-Fi Direct, Bluetooth LE |
| Supabase | Postgres schema + RLS | `supabase/migrations/` — TEST project only |

## Quick start

```bash
npm install                 # installs server + client deps, checks better-sqlite3
cp .env.example .env        # optional: set FOUNDER_EMAIL, GROQ_API_KEY, PAYSTACK_SECRET_KEY…
npm run build               # build the React client into client/dist
npm start                   # http://localhost:3000
```

`npm test` runs the end-to-end API suite (`tests/run-tests.js`) against a throwaway database.

Development with hot reload:

```bash
npm run dev                 # API on :3000
npm run build -- --watch    # client rebuild (or `vite --config client/vite.config.js`)
```

## Accounts and the Founder

There are no fabricated users. Register through the UI, then set `FOUNDER_EMAIL` to that address
and restart: `ensureFounder()` binds Founder/CEO authority to exactly that account. The database
enforces a single Founder with a partial unique index, and the client can never set the flag.

Administrators get only the permissions explicitly listed in `users.permissions`. No other account
can ever hold Founder authority.

## Features

* **Social** — feed, audience-scoped posts (public / friends / private), images, video, 3D models,
  likes and comments that update in place without resetting scroll, shares, edit, delete through a
  post menu plus confirmation dialog, content reports.
* **Accounts** — registration, login, logout, password reset, full profile (photo, cover, bio,
  phone, country/state/city, address, occupation, education, skills, interests, website, social
  links, language) with per-field privacy controls.
* **Friends** — search, requests, accept/reject/cancel, friends list, remove, block.
* **Messaging** — E2E-encrypted private conversations (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM),
  text, images, video, files and voice notes, delivery/read status, offline outbox with automatic
  resend and de-duplication by client id.
* **Marketplace** — listings with media, search, seller profiles, orders, commission computed from
  the approved tiers, seller verification, fraud reporting, Paystack adapter (real API calls only).
* **3D** — upload GLB/glTF with validation, viewer with orbit/zoom, mobile-optimised rendering.
* **#ash AI** — server-side Groq proxy for writing help, reply suggestions, translation, captions
  and content understanding. It never reads private messages; users paste what they want help with.
* **Founder Dashboard & Admin** — user/post/message/market counts, system health, networking and
  UAR activity, reports queue, role-based moderation, audit log.
* **UAR** — automatic route selection, low-battery downgrade below 20%, plain-language delivery
  status ("Sent via Internet", "Sent via #ash Nearby", "Saved Offline — Will Send Automatically"),
  voluntary relay consent with immediate revocation.

Commission tiers (unchanged, as approved): ₦1–100,000 → 3% · ₦100,001–500,000 → 5% ·
₦500,001–1,000,000 → 3% · ₦1,000,001–5,000,000 → 2.5% · ₦5,000,001–10,000,000 → 2%.

## Documentation

* [`docs/OFFLINE.md`](docs/OFFLINE.md) — offline-first data layer, sync API, nearby radio bridge
* [`docs/FEATURES.md`](docs/FEATURES.md) — verified / unverified / external-dependency status
* [`docs/TESTING.md`](docs/TESTING.md) — what the suite proves, and what it does not
* [`docs/SECURITY.md`](docs/SECURITY.md) — auth, CSRF, RLS, encryption design, limits
* [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — server deploy, Supabase migrations, Android build
* [`native/README.md`](native/README.md) — the native radio bridge

## Not included (by instruction)

No #ash Jobs, #ash Skills, #ash Connect, #ash Games or #ash Creative modules. #ash AI stays an
assistant inside #ash Mesh, not a separate product.

## License

Proprietary — © Hassan Shuaibu Adam / #ash Mesh. All rights reserved.
