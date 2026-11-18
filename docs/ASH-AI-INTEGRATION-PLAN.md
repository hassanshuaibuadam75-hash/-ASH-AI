# #ash AI / #ash Brain — Missing Components, Integration Points and Staged Plan

**Status:** documentation and planning only. No code changed, no deployment, no database access.
**Repository audited:** `hassanshuaibuadam75-hash/-ASH-AI` (branch `appjet`, HEAD `079462a`) — this is the **#ash Mesh** project.
**Live deployment to preserve:** https://umqerolb7s.dev.ap-jt.com

**Architecture as confirmed by the Founder:**
`#ash Mesh` is the application. `@ashai` is an **integrated assistant inside it**. `#ash Brain` is a **separate Python engine** that is *not* in this repository and has **not** been verified.

> Correction to an earlier interim report: assistant thread persistence and AI support tickets **do exist**.
> They are created at runtime in `server/routes-ai.js`, not in `server/schema.sql`, which is why a schema-only
> inspection missed them.

---

## TASK A — Missing, partial and verified AI components

Status key: **VERIFIED** = implemented and covered by the existing automated suite · **PARTIAL** = some real implementation, important parts absent or unverified · **MISSING** = not present in this repository.

| # | Component | Status | Evidence in this repository | What is required |
|---|-----------|--------|------------------------------|------------------|
| 1 | AI engine and architecture | **MISSING** | No engine. The only inference is a remote HTTP call in `server/ai-groq.js` to `https://api.groq.com/openai/v1/chat/completions`. No local runtime, no orchestration layer, no routing between models. | A defined engine boundary (adapter interface) with at least one local or self-hosted backend; #ash Brain source verified first. |
| 2 | Python modules | **MISSING** | Zero Python files. Zero matches for `ash brain`/`ashbrain`/`ash_brain` across all files and all 222 commits. | #ash Brain module tree, entry point, and public API contract. |
| 3 | Model files and weights | **MISSING** | No `.gguf`, `.onnx`, `.tflite`, `.safetensors`, `.bin` or model directories. No model storage path. | Verified model assets plus a hosting decision — note that the **Free plan has no persistent disk**, so multi-GB weights cannot live in the container. |
| 4 | Model configuration | **MISSING** | Only `GROQ_MODEL` (default `openai/gpt-oss-20b`, fallbacks in `FALLBACK_MODELS`). No local model config, quantisation, context window or sampling settings. | A model configuration format owned by the engine, not the web app. |
| 5 | Inference engine | **MISSING** | No llama.cpp / ONNX Runtime / MediaPipe / TFLite / vLLM integration. `package.json` contains no ML dependency. | Chosen runtime, pinned version, CPU/RAM budget (1 vCPU / 1 GB on Free). |
| 6 | Voice recognition | **MISSING** | No speech-to-text anywhere. The only audio code is `MediaRecorder` producing a `.webm` voice-note attachment in `client/src/pages/Messages.jsx` — an attachment, not recognition. | STT path (provider or local), language hints, and honest "requires connection" labelling. |
| 7 | Text-to-speech | **MISSING** | No TTS endpoint, no voice playback control, no voice selection. | TTS endpoint, per-language voice mapping, playback and cancellation. |
| 8 | Speech-to-text | **MISSING** | Same as #6 — no transcription pipeline, no audio upload route for AI input. | Audio ingestion with size/duration limits, retention policy, and transcription. |
| 9 | Language and dialect support | **PARTIAL** | Translation is requested through the system prompt in `routes-ai.js`; no language detection, no stored language preference, no dialect data, no evaluation set, no measured results. | Detection + preference storage + dialect-aware prompting + an evaluation suite reporting per-language results. Hausa/Kano dialect coverage cannot be claimed without measurements. |
| 10 | Memory and conversation persistence | **VERIFIED** | `ensureAiThreadSchema()` in `routes-ai.js` creates `ai_thread_messages` (id, user_id, role, content, client_id, created_at) with a unique `(user_id, client_id)` index. `GET /ai/thread` returns the last 300 messages; `POST /ai/thread/messages` is rate-limited (120/hour) and idempotent via `client_id`; `DELETE /ai/thread` clears it. The same thread renders in Messages and on `/ai`. | Extend, do not replace: long-term memory, summarisation, user-visible memory controls, and retention rules. |
| 11 | Agent capabilities | **PARTIAL** | `GET /ai/actions` exists and the system prompt constrains the assistant (no money movement, no refunds, no password or key access, no Founder authority). No verified tool-calling loop, no per-tool permission registry, no approval gate for writes. | Tool registry, explicit per-tool permissions, human approval for any write, AI-tagged audit entries. |
| 12 | AI API integration | **VERIFIED** | `server/ai-groq.js`: `groqChat()`, `groqConfigured()`, `redact()`, `GroqError`, `FRIENDLY_ERRORS`; key read from `process.env.GROQ_API_KEY` only; honest 503 when unconfigured; no fabricated replies. Endpoints: `/ai/status`, `/ai/account`, `/ai/summary`, `/ai/actions`, `/ai/marketplace/help`, `/ai/moderate/flag(s)`, `/ai/support/tickets`, `/ai/thread`, plus `@ashai` publishing in `routes-ai-official.js`. | Keep as the reference adapter; add Brain as a second backend behind the same interface. |
| 13 | Required dependencies | **MISSING** | No ML/voice dependencies. Current stack: express, better-sqlite3, react, react-dom, react-router-dom, three, vite, multer, cookie-parser. | Declared, pinned dependency set for the engine, plus licence review (weights and runtimes carry licences). |
| 14 | Automated tests | **PARTIAL** | Existing suites cover AI honesty (no key → safe error, no key leakage, no approval-free posting) and the full app. There are **no** tests for voice, dialects, engine selection, memory controls, tool permissions or offline AI. | New suites per stage; nothing claimed as working without a passing check. |

**Additional verified AI assets not on the list above:** AI moderation (`server/moderation.js`, `/ai/moderate/flag`), AI-assisted support tickets (`support_tickets` + `support_messages` tables with status transitions and AI summary), and the official `@ashai` identity (`AI_ACCOUNT`: `ashai` / `ai@ashmesh.com` / `#ash AI`).

### #ash Brain — components that cannot be audited

Not present, therefore **not assessed**: engine architecture, Python modules, weights, model configuration, inference runtime, training/fine-tuning pipeline, test coverage, licences, hardware requirements, language coverage, and the Mesh↔Brain authentication model. I make no claim about any of them.

---

## TASK B — Reusable #ash Mesh integration points

All of these exist and must be **reused, not modified**, when the engine is integrated. Route count across `server/*.js`: **166**.

| Area | Existing implementation | How #ash AI attaches |
|------|------------------------|----------------------|
| Authentication and user identity | `server/lib.js`: `SESSION_COOKIE`, `CSRF_COOKIE`, `hashPassword`, `verifyPassword`, `createSession`, `destroySession`, `loadSession`, `requireAuth`, `requireFounder`, `csrfProtection`, `rateLimit`; `sessions` table; `routes-auth.js` (`/auth/login`, `/auth/register`, `/auth/me`, password reset/change) | Every AI call is authenticated server-side. No AI identity may be inferred from chat text. |
| @ashai account | `routes-ai-official.js`: `AI_ACCOUNT`; `GET /ai/official`, `POST /ai/official/publish`, `DELETE /ai/official/posts/:id` | The single official AI identity; publishing stays operator-driven and audited. |
| Messages and conversation interface | `client/src/pages/Messages.jsx`, `client/src/components/AiThread.jsx`, `components/AssistantFab.jsx`; `routes-chat.js` (`/conversations`, `/conversations/:id/messages`, `/messages/sync`, attachments, read receipts) | The @ashai thread is already surfaced in Messages; voice and memory UI extend these components. |
| Backend API routes | 166 routes across `routes-auth`, `routes-social`, `routes-chat`, `routes-content`, `routes-market`, `routes-wallet`, `routes-admin`, `routes-moderation`, `routes-backup`, `routes-founder-editor`, `routes-ai`, `routes-ai-official`, `routes-heritage`, `routes-sync` | New AI endpoints follow the same auth + CSRF + rate-limit pattern. |
| Database and persistent storage | `server/schema.sql` (33 tables) plus runtime tables `ai_thread_messages`, `support_tickets`, `support_messages`; `data/ash-mesh.db`, `data/uploads/`, `data/backups/` | Additive migrations only. Existing tables are never rewritten. |
| AI provider integration | `server/ai-groq.js` | Becomes the adapter: Groq today, #ash Brain pluggable, one health/capabilities contract. |
| Offline architecture | `client/src/uar.js` (route selection), `client/src/localdb.js`, `client/src/sync.js`, `server/routes-sync.js` (`/sync/pull`, `/sync/push`), `uar_telemetry`, `relay_consents` | Queue AI actions offline and replay idempotently; never report a cloud reply that did not happen. |
| Notifications | `notifications` table; `/notifications`, `/notifications/:id/read`, `/notifications/read-all` | Notify on support escalation, moderation outcomes and completed AI tasks. |
| Marketplace | `marketplace_listings`, `orders`, `transactions`, `wallet_ledger`, `seller_verifications`, `payout_requests`, `refunds`, `payment_events`, `seller_bank_accounts`; `routes-market.js`, `routes-wallet.js`; `/ai/marketplace/help` | AI assists and explains only; it never moves money, approves payouts or sets commission. |
| Support system | `support_tickets` + `support_messages`; `GET /ai/support/tickets`, `GET /ai/support/tickets/:id`, status transitions in `routes-ai.js` | AI triage, summaries and suggested replies with human escalation. |
| Founder Dashboard | `routes-admin.js`: `/founder/dashboard`, `/admin/overview`, `/admin/users`, `/admin/reports`, `/admin/audit`, `/admin/verifications`, role/status mutations; `requireFounder`, `requirePermission` | AI health, usage, error and moderation signals surface here; Founder authority stays exclusive. |
| Security and permission systems | `audit_logs`, `rate_events`, `sessions`, `requirePermission`, `csrfProtection`, `rateLimit`, `maxUploadBytes`, multer limits (64 MB, 8 files), E2EE public-key endpoints (`PUT /users/me/public-key`, `GET /keys/:userId`) | AI actions are authorized, rate-limited, audited and tagged as AI-originated. |

**Hard boundary:** `conversations` / `conversation_members` / `messages` are the **end-to-end-encrypted user-to-user** channel. AI must never read or store content there. @ashai uses `ai_thread_messages` exclusively.

---

## TASK C — Staged integration roadmap

Each stage is additive, separately committed, and gated on the previous stage passing.

### Stage 1 — Verify and obtain the #ash Brain source
- **Dependencies:** repository URL or complete upload (modules, tests, model assets, licences).
- **Risks:** source may be incomplete, licence-incompatible, or depend on hardware unavailable here; mistaken identity with the Mesh repo.
- **Acceptance:** a source manifest exists; provenance recorded; no code imported yet.
- **Rollback:** nothing changed — no rollback needed.

### Stage 2 — Audit modules, models, dependencies, licences, tests
- **Dependencies:** Stage 1.
- **Risks:** untested modules presented as complete; copyleft weights; unpinned dependencies; missing evaluation results.
- **Acceptance:** read-only audit report listing per-module status, dependency and licence findings, and the actual test results observed.
- **Rollback:** none required (read-only).

### Stage 3 — Define the secure engine integration architecture
- **Dependencies:** Stage 2 verdict; decision on how Brain runs (service / local process / library).
- **Risks:** coupling Mesh to an unstable interface; leaking keys; unbounded request size or latency.
- **Acceptance:** a written adapter contract (`chat`, `health`, `capabilities`, error taxonomy), auth model, timeout and size limits, and an offline fallback statement.
- **Rollback:** document only.

### Stage 4 — Integrate the verified engine into the backend
- **Dependencies:** Stage 3 contract; hosting decision (Free plan: 1 vCPU / 1 GB, **no persistent disk**).
- **Risks:** OOM or CPU starvation on 1 vCPU; slow cold starts; secrets in logs; regression of existing AI endpoints.
- **Acceptance:** engine selected by environment, Groq still works unchanged, health endpoint reports truthfully, full existing suite green.
- **Rollback:** disable the engine flag; Groq path remains default; revert commit.

### Stage 5 — Connect @ashai to the Messages interface
- **Dependencies:** Stage 4.
- **Risks:** breaking the existing thread; duplicate messages on retry; scroll/regression issues on Android.
- **Acceptance:** one stable thread per user across Messages and `/ai`; navigation and restart preserve history; idempotent send verified by test.
- **Rollback:** revert UI commit; `ai_thread_messages` retained (additive).

### Stage 6 — Persistent conversations and multilingual capabilities
- **Dependencies:** Stage 5; language coverage data from Brain (or provider).
- **Risks:** cross-user leakage; wrong language auto-selection; claiming dialect support without measurement.
- **Acceptance:** isolation tests per user; language preference stored and honoured; evaluation results reported per language, with unsupported cases named.
- **Rollback:** additive tables only; revert commit leaves data intact.

### Stage 7 — Voice capabilities where supported
- **Dependencies:** Stage 6; STT/TTS provider choice or local model; Android microphone permission flow.
- **Risks:** recording without consent; audio retention; presenting simulated voice as real; offline misrepresentation.
- **Acceptance:** explicit permission prompt, visible recording state, transcription accuracy reported, TTS playback verified, offline behaviour labelled honestly.
- **Rollback:** feature flag off; audio files deletable.

### Stage 8 — Authorized social, support and marketplace agent functions
- **Dependencies:** Stages 4–7; permission model sign-off.
- **Risks:** AI performing writes without approval; financial actions; moderation overreach; Founder-authority confusion.
- **Acceptance:** per-tool permissions enforced server-side; every write requires approval; AI actions tagged in `audit_logs`; no money movement, no commission changes, no payouts.
- **Rollback:** disable tool registry; existing endpoints unaffected.

### Stage 9 — Test online/offline, security, Android compatibility, performance
- **Dependencies:** Stages 4–8.
- **Risks:** Free-plan data reset on redeploy invalidating test data; device availability; load assumptions.
- **Acceptance:** full suite green; offline queue replay verified; security checks pass; Android layout and keyboard behaviour verified; performance stated as measured, not assumed.
- **Rollback:** revert to last known-good commit; deployment rollback only with Founder approval.

### Stage 10 — Independent integration verification
- **Dependencies:** Stage 9 evidence.
- **Risks:** overstating completion; mistaking a mock for a live engine.
- **Acceptance:** a signed-off checklist distinguishing verified, partial and missing, with commands and observed output for each verified item.
- **Rollback:** documentation only.

---

## Security and compatibility risks

1. **E2EE boundary.** AI must never touch `messages`. Any design that reads private conversations violates the platform's core promise.
2. **Prompt injection.** User content and marketplace listings can carry instructions; the engine must treat retrieved content as data, not authority.
3. **Secrets.** `GROQ_API_KEY` and any `BRAIN_*` key stay server-side; never in client bundles, logs or chat history.
4. **Model provenance.** Unverified weights can carry licence restrictions or malicious artefacts; nothing is imported before Stage 2.
5. **Free-plan limits.** 1 vCPU / 1 GB RAM, no persistent disk, and **the container database starts empty after every redeploy** — local models cannot be hosted here, and test data does not survive a rebuild.
6. **Android.** `native/` has Java sources, `AndroidManifest.xml` and `capacitor.config.json` but **no Gradle build files**, and no Android SDK is available here, so no APK can be produced in this environment. Device-level voice and radio behaviour stays unverified.
7. **Offline honesty.** No AI capability may be reported as working offline unless a local model is actually present.
8. **Cost control.** Provider calls need per-user quotas; `ai_usage` and `rate_events` are the enforcement points.

---

## Required files and external dependencies

**Already present:** `GROQ_API_KEY` (optional; absent → honest 503).

**Required later, none of them now:** a Brain endpoint plus credential (names to be agreed at Stage 3), a voice provider or local model, and storage for model assets if any are hosted.

**Not required for AI work:** Paystack credentials — payments are Marketplace-only and untouched by this plan.

---

## Verified completion

| Measure | Value |
|---|---|
| Capability areas with a working implementation | 6 of 14 (text chat, persistence, @ashai identity, moderation, support tickets, prompt-level translation) |
| Of those, covered by the existing automated suite | 4 |
| #ash Brain verified | 0% — not present |
| Approximate share of the #ash AI specification implemented | ~20% |
| Approximate share verified | ~13% |

Voice, local models, inference runtime, training, multimodal, retrieval, agents and offline AI — the bulk of the specification — are absent.
