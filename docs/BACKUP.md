# #ash Mesh — Data Durability, Backups and Recovery (Stage A)

Scope: this document covers **Stage A only** — data durability. It does not describe or
approve any later stage.

## 1. What actually holds the data

| Data | Where it lives | Survives a redeploy? |
| --- | --- | --- |
| Accounts, profiles, posts, comments, likes, friendships, conversations, messages, marketplace records, audit logs, sessions | one SQLite database, `DATA_DIR/ash-mesh.db` (WAL mode) | **No** on the Free plan |
| Profile photos, post media, 3D models, message attachments | files on disk, `DATA_DIR/uploads` | **No** on the Free plan |
| Snapshot files + checksum sidecars | `BACKUP_DIR` (default `DATA_DIR/backups`) | **No** on the Free plan |
| Anything you download to your own machine | your device | **Yes** |

The Free hosting plan has **no persistent disk**. The container filesystem, including the
database and any snapshot stored inside it, is discarded when the app is rebuilt or the
container is replaced. That is a hosting limitation, not an application bug, and it cannot be
fixed from application code.

Two consequences follow, and both are handled:

1. **Snapshots inside the container are a convenience, not durability.** The application says
   so plainly in the Founder panel and in `GET /api/founder/backups` (`policy.durableStorage`
   is `false`, plus an explicit warning string).
2. **Durability requires an off-platform copy.** The Founder downloads a single archive that
   contains the database snapshot *and* every uploaded file, and keeps it outside the hosting
   container. Restoring that copy is a supported operation (see §5).

A persistent disk would remove limitation (1). It is included with the Starter ($5/month) and
Pro plans (Settings → Billing). It has not been purchased and Stage A did not purchase it.

## 2. How a snapshot is taken

`server/backup.js`

- `VACUUM INTO` writes a consistent copy of the live WAL database. A plain file copy is never
  used, because committed pages can still live in the `-wal` file and would be missed.
- Each snapshot gets a sidecar `*.json` recording `createdAt`, `reason`, `sha256`,
  `sizeBytes`, `tableCount`, per-table `rows` and the integrity result.
- A snapshot is **not** considered valid until it is opened again and passes
  `PRAGMA integrity_check`. `verifyBackup()` re-reads the file and compares the checksum with
  the recorded one.
- Retention keeps the newest `BACKUP_RETENTION` snapshot + sidecar pairs and deletes older
  ones.

## 3. Automatic backups

A scheduler starts with the server (`startBackupScheduler`) and writes a snapshot every
`BACKUP_INTERVAL_MINUTES`, after `BACKUP_INITIAL_DELAY_MS`. It runs without any user action.
The drill proves this: it waits for a snapshot whose `reason` is `scheduled` and checks its
integrity.

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `BACKUP_DIR` | `DATA_DIR/backups` | absolute or relative path | where snapshots are written |
| `BACKUP_RETENTION` | `14` | 2–60 | newest N snapshots kept |
| `BACKUP_INTERVAL_MINUTES` | `360` | 5–1440 | scheduled snapshot interval |
| `BACKUP_INITIAL_DELAY_MS` | `15000` | 500–60000 | delay before the first scheduled snapshot |
| `BACKUP_SCHEDULER` | on | set to `off` to disable | disables the scheduler entirely |

No secret is required for backups, and no credential is exposed by any backup response (the
drill asserts this).

## 4. Founder-only API

Every route below is guarded by `requireFounder`, which reads `is_founder` from the
authenticated account row. A display name, username, email or chat claim is never consulted.
Restore and export are rate limited and written to the audit log.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/founder/backups` | policy, retention, warnings, snapshot list |
| POST | `/api/founder/backups` | create a snapshot now (`reason: manual`) |
| POST | `/api/founder/backups/:name/verify` | re-verify a snapshot against its checksum |
| GET | `/api/founder/backups/:name/download` | download one snapshot `.db` |
| POST | `/api/founder/backups/:name/restore` | restore a stored snapshot |
| POST | `/api/founder/backups/restore-upload` | restore from an uploaded `.db` (≤256 MB) |
| GET | `/api/founder/export` | one ZIP: snapshot + manifest + all uploaded files |

The Founder UI is **Founder Dashboard → Data & Backups** (`client/src/components/DataBackupsPanel.jsx`),
with create, verify, download, restore (two-step confirmation), restore-from-file and
archive download.

## 5. Recovery procedure

**A. Undo a bad change with a recent snapshot**

1. Founder Dashboard → Data & Backups.
2. Pick the newest snapshot with `integrity: ok` → **Restore** → **Yes, restore this snapshot**.
3. The server takes a `pre-restore` safety snapshot first, restores inside one transaction,
   then re-runs integrity and foreign-key checks. A failure rolls back and returns HTTP 409
   with the reason, and the live data is untouched.

**B. Recover after a redeploy wiped the container (the Free-plan case)**

1. Open the app, sign in as Founder.
2. Founder Dashboard → Data & Backups → **Restore from file**, choose the `.db` inside your
   downloaded archive (`database/ash-mesh.db` in the ZIP).
3. Uploaded files are **not** restored by a database restore — a restore replaces database
   rows only. Copy the archive's `uploads/` files back through the hosting disk if a
   persistent disk exists, or re-upload the media the platform must show. This is a real
   limitation, stated again in §6.

**C. Verify a backup you have never opened**

Use **Verify** on a stored snapshot, or restore the file into a test instance. A snapshot that
fails integrity or whose checksum does not match its sidecar must not be trusted.

## 6. Remaining limitations (honest list)

1. **No durable storage on the Free plan.** Snapshots inside the container are lost on
   redeploy. Only downloaded archives are durable. Fix requires Starter/Pro (persistent disk).
2. **No automatic off-platform upload.** Backups are not pushed to S3/Drive/another host;
   there is no provider credential for that, so the Founder must download the archive.
   Downloading is manual by design and by omission of an external account.
3. **Restore is whole-database.** There is no per-record restore and no point-in-time
   recovery. Every table present in the snapshot is emptied and refilled.
4. **Restore does not restore uploaded files.** The archive carries them; a database restore
   cannot write them back.
5. **A restore rolls the audit log back** to the snapshot's rows. A `backup.restore` entry is
   written after the restore, but events that happened after the snapshot no longer exist.
6. **Single-process SQLite.** This is appropriate for the current deployment size; it is not a
   multi-node database cluster and no replication is claimed.
7. **Concurrent restore is serialized by SQLite's write lock** and by a per-Founder rate limit
   (10 restores/hour). A second restore during one restore fails rather than interleaving.

## 7. Drill evidence (TEST data only)

`tests/backup.test.mjs` runs a real end-to-end drill against a temporary `DATA_DIR` — no LIVE
database, no production data, no external service. Latest result: **55/55 checks passed**.

It proves, in one run:

- Founder signs in with server-configured credentials; anonymous and non-Founder accounts are
  refused on every backup route (list, create, export, restore).
- A real account publishes a post, comments, likes, becomes friends, sends an encrypted
  message and uploads a profile photo; the uploaded file exists on disk outside the database.
- A snapshot passes its own integrity check, records a checksum/size/row counts, and its
  sidecar exists on disk.
- Re-verification matches the recorded checksum, and the downloaded file is byte-identical.
- The archive contains manifest, database and uploaded files, and its manifest carries the
  snapshot checksum and recovery steps.
- After deleting a post and creating a later account, a restore brings the post, its comments,
  the like, the friendship and the conversation back, removes the later account, keeps the
  Founder signed in, and makes restored row counts match the snapshot exactly.
- Restore reports healthy integrity with no foreign-key violations and took a pre-restore
  safety snapshot.
- Retention keeps only the configured number of snapshots and prunes the rest from disk.
- Path traversal (`../`), a non-SQLite file and a corrupt SQLite file are all rejected.
- An off-platform `.db` upload restores the same way, and the restore is audited.
- No backup response exposes credentials.
- The scheduler writes a snapshot with no user action.

A defect this drill caught and that is now fixed: `restoreBackup()` took its pre-restore
safety snapshot *before* opening the snapshot being restored, and creating that safety
snapshot applied retention, which could prune the very file being restored
(`SQLITE_CANTOPEN`). The restore now copies the source snapshot outside the backup directory
first, so retention can never delete the file mid-restore.
