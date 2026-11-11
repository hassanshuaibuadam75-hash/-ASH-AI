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
| POST | `/api/founder/export/restore` | restore a ZIP export **including uploaded media** |

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
2. Founder Dashboard → Data & Backups → **Restore from archive (.zip)**, choose the archive
   you downloaded earlier. This is the complete recovery path: it restores the database rows
   **and** every uploaded file carried by the archive (see §8).
3. Confirm the summary dialog. The panel reports rows restored and media files restored.
4. **Restore from file** (a bare `.db`) still exists for database-only recovery, but it
   replaces rows only — it cannot write media back. Use the archive unless you have no media.

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
4. **A bare `.db` restore does not restore uploaded files.** The ZIP archive does (§8); a
   database-only restore cannot write media back.
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

## 8. Archive (ZIP) restore — rows *and* media

`restoreArchive()` in `server/backup.js`, exposed as `POST /api/founder/export/restore`
(Founder only, 10 restores/hour) and **Founder Dashboard → Data & Backups → Restore from
archive (.zip)**.

Order of operations — nothing live is touched until every input has been validated:

1. **Parse and validate the archive.** The ZIP must open, contain a manifest, and declare a
   format this build understands. Entries are resolved to absolute paths and rejected if
   they escape the extraction root (ZIP-slip), so `../` can never write outside staging.
2. **Verify the database copy.** The staged snapshot must be a real SQLite file that passes
   `PRAGMA integrity_check`; its checksum is compared with the manifest when one is recorded.
3. **Verify every media file.** Each file listed in the manifest is extracted into a staging
   directory and hashed; a size or `sha256` mismatch aborts the restore with HTTP 400 before
   any live file is replaced.
4. **Take a safety snapshot** (`reason: pre-archive-restore`) so the pre-restore state is
   recoverable.
5. **Swap the database** through the same transactional path as a snapshot restore, then
   **apply the media files** while journaling every create/overwrite so the write can be
   replayed backwards.
6. **Roll back on any failure.** If the database step or the media step throws, the media
   journal is replayed (new files removed, overwritten files restored byte-for-byte), the
   safety snapshot is restored, the reason is returned as HTTP 409 and the failure is audited
   as `backup.restore-archive-failed`. The audit entry for success is `backup.restore-archive`.

### Drill evidence — `tests/archive-restore.test.mjs`, **54/54 checks passed**

Runs against a temporary `DATA_DIR` (ports 4611–4613), never LIVE, never production data.

- Two disposable accounts register, one publishes a post with a real uploaded photo, another
  comments and likes, the pair become friends and exchange an encrypted message.
- `GET /api/founder/export` returns a ZIP whose manifest lists the database plus each media
  file with `sizeBytes` and `sha256`; the media bytes are present inside the archive.
- **Disaster**: the post is deleted, the media files are removed from disk and a later
  account is created.
- **Restore**: posting the same ZIP to `/api/founder/export/restore` brings back the post, its
  comments, the like, the friendship, the conversation with its E2EE envelope, and the media
  file — which then serves over `GET /api/media/:id` with `200` and `image/png`.
- Row counts match the snapshot, and the restore is audited.
- Anonymous callers get 401 and a non-Founder member gets 403.
- **Failure injection** (`ARCHIVE_RESTORE_FAULT`, only active when `NODE_ENV=test`):
  - fault after the database swap → 409, database *and* media unchanged, sessions intact;
  - fault after the media swap → 409, media journal restores the exact original bytes.
- **Hostile archives** are rejected with 400 and zero live changes: a non-ZIP file, an entry
  named `uploads/../escape.png`, an archive with no manifest, and an archive whose media
  checksum does not match.

A defect this drill caught and that is now fixed: the `after-media` fault hook was invoked
outside the rollback `try`, so a media-stage failure returned a bare HTTP 500 and left the
journal unreplayed. The hook now runs inside the guarded block, so the same failure returns
409 and restores the media.

### Browser click-through (Founder Dashboard → Data & Backups)

Verified in Chromium against a disposable `DATA_DIR`: Founder sign-in → Founder Dashboard →
Data & Backups → **Create snapshot** → **Verify** → **Download archive (.zip)** →
**Restore** → **Yes, restore this snapshot**. Each step produced its real confirmation
(`Snapshot created`, `Snapshot verified against its recorded checksum.`, `Archive downloaded.
Keep it outside the hosting container.`, `Snapshot restored. Accounts, posts and messages are
back.`) with no page or console errors.

### What is still not automatic

Archive restore is a **manual, Founder-driven** operation. Nothing uploads an archive to
S3/Drive, and nothing restores one without a human choosing the file, because there is no
provider credential and no persistent disk on this plan. Disaster recovery is therefore
**documented and tested, not automatic** — see §6.1 and §6.2.
