# #ash Mesh — Stage H: Hosting, Durable Storage and Domain

**Status: EVALUATION COMPLETE — IMPLEMENTATION BLOCKED ON EXTERNAL INPUT**

This document is the Stage H deliverable. It records what the deployment can and cannot
guarantee today, evaluates the available durability options, recommends one, states its cost,
and defines the exact implementation and recovery drill that will run once the required
credentials or plan upgrade exist.

Nothing in this stage was purchased, upgraded, deployed or configured. No external account was
created. No LIVE data was touched.

---

## 1. Purpose and scope

Stage A delivered verified backups *inside* the application: snapshot, integrity check,
checksum, retention, Founder-only API, ZIP archive containing rows **and** media, and a
restore path with rollback handling. That work is complete and tested.

Stage H addresses the question Stage A deliberately left open:

> If the container is replaced, is the data still recoverable?

The answer today is **only if a human previously downloaded an archive**. This document
explains why, what the options are, and what it costs to close the gap.

Out of scope: application features, Marketplace, Paystack, Nearby, #ash AI. No code in those
areas was read for modification or changed.

---

## 2. What exists today (verified from source)

| Property | Observed value | Source |
|---|---|---|
| Database | Single SQLite file `ash-mesh.db` | `DATA_DIR` |
| Uploaded media | `DATA_DIR/uploads/` | `DATA_DIR` |
| Snapshot location | `BACKUP_DIR` or `DATA_DIR/backups` | `server/backup.js:39` |
| Retention | 14 snapshots by default, clamped 2–60 | `BACKUP_RETENTION` |
| Interval | 360 min default (6 h), clamped 5–1440 | `BACKUP_INTERVAL_MINUTES` |
| First backup | 15 s after boot, clamped 0.5–60 s | `BACKUP_INITIAL_DELAY_MS` |
| Scheduler kill switch | enabled unless `BACKUP_SCHEDULER=off` | `server/backup.js:42` |
| Snapshot verification | `PRAGMA integrity_check` + SHA-256 sidecar `.json` | `server/backup.js:83,107,177` |
| Retention pruning | removes oldest snapshot + sidecar pairs | `server/backup.js:219` |
| Archive restore | rows **and** media, with fault injection for tests | `ARCHIVE_MAX_FILE_BYTES`, `ARCHIVE_MAX_TOTAL_BYTES`, `ARCHIVE_RESTORE_FAULT` |
| Restore concurrency | serialized by SQLite write lock + 10 restores/hour per Founder | `docs/BACKUP.md §6.7` |

All of `ash-mesh.db`, `backups/` and `uploads/` live **inside the container filesystem**.
`data/` is not tracked in Git (`git ls-files data` is empty), which is correct — no user data
or media is committed to the repository.

**Drill evidence already on record:** backup drill 55/55 checks, archive restore drill 54/54
checks, both against a temporary `DATA_DIR` with TEST data only (`docs/BACKUP.md §7, §8`).

---

## 3. The durability gap (evidence, not theory)

1. The Docker image is `node:24-alpine`, runs as `USER node`, and declares **no `VOLUME`**
   (`Dockerfile`). Container-layer writes are therefore not persisted by the image.
2. On this Free-plan deployment the container database is observed to start **empty after a
   redeploy**: an account valid on a previous build returned 401 on `/api/auth/login`
   afterwards, and re-registering the same username succeeded.
3. Consequence: `DATA_DIR`, `BACKUP_DIR` and every snapshot inside them share the fate of the
   container. The scheduler protects against *logical* damage (corruption, bad restore,
   accidental deletion within one container lifetime) but **not** against redeploy, host
   replacement or disk loss.

So the current honest position is: **disaster recovery is documented and tested, but not
automatic, and not durable without a human-downloaded archive.**

---

## 4. Option A — AppJet persistent disk (Starter or Pro)

A persistent volume mounted at `DATA_DIR` would make `ash-mesh.db`, `uploads/` and `backups/`
survive redeploys without any application change, because every path already derives from
`DATA_DIR`.

- **Advantages:** no new code; survives redeploy and container replacement; backups and media
  protected together; no third-party account.
- **Limits:** paid feature. Not available on the current Free plan. Does not protect against
  deletion or corruption *inside* the disk — a bad restore or operator error still needs a
  restore point, so this complements snapshots rather than replacing off-platform copies.
- **Cost:** Starter **$5/month**, or Pro. Both include persistent disks and custom domains.
- **Requires your approval.** I will not upgrade or create a disk on your behalf.

If you choose this, the operational change is small: set `DATA_DIR` to the mount path and
confirm the mount's ownership allows the non-root `node` user. Existing data would need a
one-time migration (download an archive, mount the disk, restore) — I would script and test
that against TEST data first.

---

## 5. Option B — Off-platform S3-compatible backup (recommended)

Push each verified snapshot plus a manifest to object storage outside AppJet, so a copy exists
that no redeploy can remove.

- **Advantages:** works on the current Free plan; independent failure domain; cheap; keeps the
  existing snapshot/checksum logic and adds a transport step.
- **Limits:** needs a provider account and credentials you create; adds one outbound dependency;
  a restore is still a deliberate human action.
- **Credentials required:** endpoint, bucket, access key, secret key, region. Nothing exists
  today — `rg` over `server/` and `package.json` finds no S3 client, and `.env.example` has no
  storage variables.

Providers that offer S3-compatible APIs with a free or near-zero entry tier exist (Backblaze
B2, Cloudflare R2, Wasabi, AWS S3, and self-hosted MinIO). **I have not verified current
pricing or free-tier terms for any of them** — confirm on the provider's own pricing page
before choosing. Snapshot size here is on the order of hundreds of KB, so cost is negligible
even at paid rates.

---

## 6. Option C — Status quo: Founder-downloaded archives

Already working today and not to be removed.

- **Advantages:** zero cost, zero new dependency, fully verified end-to-end.
- **Limits:** manual; RPO equals the interval between downloads, which is whatever the operator
  chooses — not a guaranteed number.

This remains the fallback regardless of which option is adopted.

---

## 7. Comparison

| | A — Persistent disk | B — Off-platform object storage | C — Manual archive |
|---|---|---|---|
| Survives redeploy | Yes | Yes (as a restore source) | Yes |
| Survives container loss | Yes | Yes | Yes, if downloaded |
| Survives accidental deletion | No | Yes | Yes |
| Needs plan upgrade | Yes ($5/mo Starter) | No | No |
| Needs external account | No | Yes | No |
| Code changes | None | New module + scheduler hook | None |
| Automatic | Yes | Yes | No |
| Verified today | No | No | **Yes** |

**Recommendation:** adopt **B** for durability now, keep **C** as the operator fallback, and
treat **A** as the preferred upgrade if you ever want the live database itself to survive a
redeploy without a restore step. B and A are complementary, not competing.

---

## 8. Proposed implementation for B (designed, NOT built)

To be written only after you supply credentials or approve the approach.

**Module:** `server/offsite-backup.js`
- `uploadSnapshot(snapshotPath)` — uploads the `.db` and its `.json` sidecar, plus a manifest
  entry (name, size, `sha256`, row count, `reason`, `createdAt`).
- `verifyRemote(name)` — re-reads the object and compares its SHA-256 with the manifest before
  the local copy is eligible for retention pruning.
- `listRemote()` / `pruneRemote()` — mirrors `BACKUP_RETENTION` on the remote side.
- Failure policy: a failed upload **never** deletes or invalidates the local snapshot, and is
  recorded in the audit log; the scheduler continues on its next tick.

**Hook:** called after the existing `createBackup()` verification step succeeds — never before,
so only integrity-checked snapshots leave the host.

**Proposed environment variables** (names only; no values exist yet):

```
OFFSITE_BACKUP_ENABLED=1
OFFSITE_BACKUP_ENDPOINT=
OFFSITE_BACKUP_BUCKET=
OFFSITE_BACKUP_REGION=
OFFSITE_BACKUP_ACCESS_KEY=
OFFSITE_BACKUP_SECRET_KEY=
```

Secrets stay server-side, are never returned by an API, and never appear in logs — the existing
`redact()` convention is reused.

**Restore path:** Founder downloads or selects a remote snapshot in Founder Dashboard → Data &
Backups; the server fetches it, verifies the checksum against the manifest, then runs the
existing archive-restore routine unchanged. An unverified object is refused.

**Tests to add** (mirroring the existing drill style): upload success, checksum mismatch
refused, provider unreachable leaves the local snapshot intact, duplicate upload idempotent,
retention pruning on the remote side, and a full restore from a remote object into a temporary
`DATA_DIR`.

---

## 9. Recovery drill (defined, NOT yet executed)

This is the Stage H acceptance test. It cannot run until a remote copy exists.

1. Create disposable TEST records: one account, one post, one friendship, one conversation with
   a message, one uploaded media file.
2. Create a snapshot and upload it off-platform; record the manifest `sha256`.
3. Destroy the local `DATA_DIR` entirely (simulating container loss).
4. Restore **only** from the off-platform object.
5. Verify: the account authenticates, the post exists exactly once, the friendship is intact,
   the message decrypts with its original key material, and the media file is byte-identical.
6. Record elapsed time from step 3 to step 5 as the measured RTO.

Until step 6 produces a number, **no recovery-time figure will be quoted** — any RTO stated
before that drill would be an estimate, not evidence.

---

## 10. Cost summary

| Item | Cost | Status |
|---|---|---|
| AppJet Starter (persistent disk + custom domain) | $5/month | Not purchased |
| AppJet Pro | Higher tier | Not purchased |
| S3-compatible object storage | Provider-dependent; negligible at this data size | Not created |
| Current setup (Free plan, manual archives) | $0 | In use |

No purchase, upgrade or account creation will happen without your explicit approval.

---

## 11. Custom domain (`ashmesh.com`)

Also a paid feature on AppJet — included with Starter and Pro, unavailable on Free.

When available, the steps are: point the domain's DNS at the hosting target AppJet provides,
add the domain in Settings, wait for certificate issuance, then set `PUBLIC_APP_URL` to
`https://ashmesh.com` so password-reset links and payment callbacks use the correct origin.
`PAYMENT_CALLBACK_URL` must be updated to match, or Paystack callbacks will land on the old
host. None of this is configured today, and no DNS record was changed.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Off-platform credentials leak into Git or logs | Critical | Server-only env vars, redaction, no client exposure, `.env` not tracked |
| Provider outage during upload | Low | Local snapshot retained; retry next tick; audit-logged |
| Remote object corrupted or truncated | High | Checksum verified before any restore is permitted |
| Retention prunes the only good copy | High | Remote pruning only after successful upload verification; retention already paired-file safe |
| Operator restores the wrong snapshot | High | Whole-DB restore is explicit and rate-limited; a `pre-restore` snapshot is taken first |
| Silent divergence between remote and local | Medium | Manifest comparison on every list; mismatch reported to the Founder |

---

## 13. Acceptance criteria and current status

| Criterion | Status |
|---|---|
| Evaluate persistent disk availability | **Done** — §4 |
| Evaluate off-platform S3-compatible storage | **Done** — §5 |
| Document cost before requesting approval | **Done** — §10 |
| Evaluate custom domain configuration | **Done** — §11 |
| Automated off-platform backup implemented | **BLOCKED** — needs provider credentials |
| Checksums and retention verified remotely | **BLOCKED** — no remote target exists |
| Recovery drill from an independently stored archive | **BLOCKED** — depends on the two items above |
| Recovery time measured and documented | **BLOCKED** — measured only by the drill |

Nothing above is marked complete on the basis of design alone.

---

## 14. Rollback

This stage changed no runtime behaviour: it adds one documentation file. If any part of the
proposed implementation is later adopted and misbehaves, the rollback is to set
`OFFSITE_BACKUP_ENABLED=0` — the scheduler then behaves exactly as it does today — and to
delete the module. Local snapshots and the manual archive path are unaffected either way.

---

## 15. What I need from you

One of:

1. **AppJet Starter or Pro** (Settings → Billing) — unlocks the persistent disk and
   `ashmesh.com`, removing the redeploy data loss described in §3.
2. **S3-compatible credentials** for an account you create — I then build §8 and run the §9
   drill.
3. **Neither, for now** — keep manual archives (§6) and accept the documented RPO.

Until one of those arrives, the durability position is exactly what `docs/BACKUP.md` states:
backups are verified, restores are tested, and disaster recovery is **documented, not
automatic**.
