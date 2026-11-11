// #ash Mesh — Founder App Editor store.
//
// Every application edit is a *version* of one configuration document, so nothing is
// destructive and nothing is unrecoverable:
//
//   proposals → applied as a TEST draft (the previous draft is kept as `superseded`)
//             → marked tested → published to LIVE (the previous LIVE version is kept)
//             → restorable at any time as a new version
//
// The published version is what the running client renders; the draft is what the Founder
// previews. Publishing and restoring never delete history, so an approved change can always
// be reversed. `created_by` comes from the authenticated session, never from chat text.
import crypto from 'node:crypto';
import { db } from './db.js';
import {
  applyOps,
  defaultConfig,
  describeChanges,
  sanitizeConfig,
  touchedPages,
  validateChanges,
} from './site-config.js';

const uid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const nowIso = () => new Date().toISOString();

export function editorError(message, status = 400, code = 'editor_error') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function ensureEditorSchema() {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS app_site_versions (
       id TEXT PRIMARY KEY,
       number INTEGER NOT NULL,
       environment TEXT NOT NULL,
       status TEXT NOT NULL,
       config TEXT NOT NULL,
       summary TEXT,
       change_log TEXT,
       created_by TEXT,
       created_at TEXT NOT NULL,
       tested_at TEXT,
       published_at TEXT,
       restored_from TEXT
     )`
  ).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_site_versions_status ON app_site_versions(status, number)').run();

  db.prepare(
    `CREATE TABLE IF NOT EXISTS app_site_proposals (
       id TEXT PRIMARY KEY,
       founder_id TEXT NOT NULL,
       instruction TEXT,
       summary TEXT,
       changes TEXT NOT NULL,
       preview TEXT NOT NULL,
       source TEXT,
       status TEXT NOT NULL,
       version_id TEXT,
       created_at TEXT NOT NULL,
       decided_at TEXT
     )`
  ).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_site_proposals_founder ON app_site_proposals(founder_id, created_at)').run();

  db.prepare(
    `CREATE TABLE IF NOT EXISTS app_editor_events (
       id TEXT PRIMARY KEY,
       actor_id TEXT,
       action TEXT NOT NULL,
       detail TEXT,
       created_at TEXT NOT NULL
     )`
  ).run();

  // Baseline: the shipped design, recorded as the first LIVE version so the very first
  // Founder change has something real to be compared with and restored to.
  const live = db.prepare("SELECT id FROM app_site_versions WHERE status = 'published' LIMIT 1").get();
  if (!live) {
    db.prepare(
      `INSERT INTO app_site_versions
         (id, number, environment, status, config, summary, change_log, created_by, created_at, published_at)
       VALUES (?, 1, 'live', 'published', ?, ?, ?, NULL, ?, ?)`
    ).run(
      uid('ver'),
      JSON.stringify(defaultConfig()),
      'Baseline configuration shipped with #ash Mesh',
      JSON.stringify(['Initial application configuration']),
      nowIso(),
      nowIso()
    );
  }
}

export function logEvent(actorId, action, detail) {
  db.prepare('INSERT INTO app_editor_events (id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(
    uid('evt'),
    actorId || null,
    action,
    typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
    nowIso()
  );
}

function serializeVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    environment: row.environment,
    status: row.status,
    config: sanitizeConfig(parseJson(row.config, null)),
    summary: row.summary || '',
    changeLog: parseJson(row.change_log, []),
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    testedAt: row.tested_at || null,
    publishedAt: row.published_at || null,
    restoredFrom: row.restored_from || null,
  };
}

function serializeProposal(row) {
  if (!row) return null;
  const changes = parseJson(row.changes, []);
  return {
    id: row.id,
    instruction: row.instruction || '',
    summary: row.summary || '',
    changes,
    changeLog: describeChanges(changes),
    preview: sanitizeConfig(parseJson(row.preview, null)),
    source: row.source || 'ai',
    status: row.status,
    versionId: row.version_id || null,
    pages: touchedPages(changes),
    createdAt: row.created_at,
    decidedAt: row.decided_at || null,
  };
}

export function liveVersion() {
  return serializeVersion(
    db.prepare("SELECT * FROM app_site_versions WHERE status = 'published' ORDER BY number DESC LIMIT 1").get()
  );
}

export function draftVersion() {
  return serializeVersion(
    db
      .prepare("SELECT * FROM app_site_versions WHERE environment = 'test' AND status = 'draft' ORDER BY number DESC LIMIT 1")
      .get()
  );
}

/** The configuration a new proposal builds on: the open draft, else what is live. */
export function baseConfig() {
  const draft = draftVersion();
  if (draft) return draft.config;
  const live = liveVersion();
  return live ? live.config : defaultConfig();
}

export function getVersion(id) {
  return serializeVersion(db.prepare('SELECT * FROM app_site_versions WHERE id = ?').get(String(id)));
}

export function listVersions(limit = 50) {
  const rows = db
    .prepare('SELECT * FROM app_site_versions ORDER BY number DESC LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return rows.map(serializeVersion);
}

export function getProposal(id) {
  return serializeProposal(db.prepare('SELECT * FROM app_site_proposals WHERE id = ?').get(String(id)));
}

export function listProposals(founderId, limit = 20) {
  const rows = db
    .prepare('SELECT * FROM app_site_proposals WHERE founder_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(founderId, Math.min(Math.max(Number(limit) || 20, 1), 100));
  return rows.map(serializeProposal);
}

function nextNumber() {
  const row = db.prepare('SELECT MAX(number) AS n FROM app_site_versions').get();
  return (row && row.n ? row.n : 0) + 1;
}

/**
 * Validate a proposed change against the current draft/live configuration and store it.
 * Nothing is applied here — a proposal is inert until the Founder approves it.
 */
export function createProposal({ founderId, instruction, changes, summary, source = 'ai' }) {
  if (!founderId) throw editorError('A Founder identity is required.', 401, 'founder_only');
  const base = baseConfig();
  const result = validateChanges(changes, base);
  if (!result.ok) throw editorError(result.error, 422, 'patch_invalid');

  const id = uid('prop');
  const changeLog = describeChanges(result.ops);
  const finalSummary =
    (summary && String(summary).trim().slice(0, 400)) || changeLog[0] || 'Proposed application change';

  db.prepare(
    `INSERT INTO app_site_proposals
       (id, founder_id, instruction, summary, changes, preview, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`
  ).run(
    id,
    founderId,
    String(instruction || '').slice(0, 2000),
    finalSummary,
    JSON.stringify(result.ops),
    JSON.stringify(result.config),
    source,
    nowIso()
  );

  logEvent(founderId, 'proposal.created', { proposalId: id, summary: finalSummary, pages: touchedPages(result.ops) });
  return getProposal(id);
}

export function cancelProposal({ proposalId, founderId }) {
  const row = db.prepare('SELECT * FROM app_site_proposals WHERE id = ?').get(String(proposalId));
  if (!row) throw editorError('That proposal no longer exists.', 404, 'not_found');
  if (row.status !== 'proposed') throw editorError('That proposal has already been decided.', 409, 'already_decided');
  db.prepare("UPDATE app_site_proposals SET status = 'cancelled', decided_at = ? WHERE id = ?").run(nowIso(), row.id);
  logEvent(founderId, 'proposal.cancelled', { proposalId: row.id });
  return getProposal(row.id);
}

/**
 * Approve a proposal: write it as a TEST draft version. The previously published LIVE
 * version is untouched, and the previous draft is kept (superseded) rather than deleted —
 * that is the automatic backup before every change.
 */
export function applyProposal({ proposalId, founderId }) {
  const row = db.prepare('SELECT * FROM app_site_proposals WHERE id = ?').get(String(proposalId));
  if (!row) throw editorError('That proposal no longer exists.', 404, 'not_found');
  if (row.status !== 'proposed') throw editorError('That proposal has already been decided.', 409, 'already_decided');

  const ops = parseJson(row.changes, []);
  const base = baseConfig();
  // Re-validate against the current draft: if the draft moved on, the proposal is stale
  // rather than silently overwriting the newer change.
  const result = validateChanges(ops, base);
  if (!result.ok) {
    throw editorError(`This proposal no longer applies cleanly: ${result.error}`, 409, 'stale_proposal');
  }

  db.prepare("UPDATE app_site_versions SET status = 'superseded' WHERE environment = 'test' AND status = 'draft'").run();

  const versionId = uid('ver');
  const changeLog = describeChanges(ops);
  db.prepare(
    `INSERT INTO app_site_versions
       (id, number, environment, status, config, summary, change_log, created_by, created_at)
     VALUES (?, ?, 'test', 'draft', ?, ?, ?, ?, ?)`
  ).run(
    versionId,
    nextNumber(),
    JSON.stringify(result.config),
    row.summary || changeLog[0] || 'Draft change',
    JSON.stringify(changeLog),
    founderId,
    nowIso()
  );

  db.prepare("UPDATE app_site_proposals SET status = 'applied', version_id = ?, decided_at = ? WHERE id = ?").run(
    versionId,
    nowIso(),
    row.id
  );

  logEvent(founderId, 'proposal.applied', { proposalId: row.id, versionId, pages: touchedPages(ops) });
  return { proposal: getProposal(row.id), version: getVersion(versionId) };
}

export function markTested(versionId, founderId) {
  const version = getVersion(versionId);
  if (!version) throw editorError('That version no longer exists.', 404, 'not_found');
  if (version.status === 'published') return version;
  if (version.status !== 'draft' && version.status !== 'tested') {
    throw editorError('Only a TEST draft can be marked as tested.', 409, 'invalid_state');
  }
  db.prepare("UPDATE app_site_versions SET status = 'tested', tested_at = ? WHERE id = ?").run(nowIso(), version.id);
  logEvent(founderId, 'version.tested', { versionId: version.id, number: version.number });
  return getVersion(version.id);
}

/** Promote a TEST version to LIVE. The previously published version is retained. */
export function publishVersion(versionId, founderId) {
  const version = getVersion(versionId);
  if (!version) throw editorError('That version no longer exists.', 404, 'not_found');
  if (version.status === 'published') throw editorError('That version is already live.', 409, 'already_live');
  if (version.status !== 'draft' && version.status !== 'tested') {
    throw editorError('Only a TEST draft or tested version can be published.', 409, 'invalid_state');
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE app_site_versions SET status = 'superseded' WHERE status = 'published'").run();
    db.prepare(
      "UPDATE app_site_versions SET status = 'published', environment = 'live', published_at = ? WHERE id = ?"
    ).run(nowIso(), version.id);
  });
  tx();

  logEvent(founderId, 'version.published', { versionId: version.id, number: version.number });
  return getVersion(version.id);
}

/**
 * Roll back: copy an earlier version's configuration forward as a NEW version, so history
 * stays intact and the rollback itself can be rolled back.
 */
export function restoreVersion({ versionId, founderId, publish = false }) {
  const source = getVersion(versionId);
  if (!source) throw editorError('That version no longer exists.', 404, 'not_found');

  const summary = `Restored version ${source.number}${publish ? ' and published to LIVE' : ' as a TEST draft'}`;
  const changeLog = [
    `Full configuration restored from version ${source.number} (${source.summary || 'no summary'})`,
    ...(publish ? ['Published to LIVE'] : ['Kept as a TEST draft for review']),
  ];

  const id = uid('ver');
  const tx = db.transaction(() => {
    if (publish) {
      db.prepare("UPDATE app_site_versions SET status = 'superseded' WHERE status = 'published'").run();
      db.prepare(
        `INSERT INTO app_site_versions
           (id, number, environment, status, config, summary, change_log, created_by, created_at, published_at, restored_from)
         VALUES (?, ?, 'live', 'published', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        nextNumber(),
        JSON.stringify(source.config),
        summary,
        JSON.stringify(changeLog),
        founderId,
        nowIso(),
        nowIso(),
        source.id
      );
    } else {
      db.prepare("UPDATE app_site_versions SET status = 'superseded' WHERE environment = 'test' AND status = 'draft'").run();
      db.prepare(
        `INSERT INTO app_site_versions
           (id, number, environment, status, config, summary, change_log, created_by, created_at, restored_from)
         VALUES (?, ?, 'test', 'draft', ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        nextNumber(),
        JSON.stringify(source.config),
        summary,
        JSON.stringify(changeLog),
        founderId,
        nowIso(),
        source.id
      );
    }
  });
  tx();

  logEvent(founderId, publish ? 'version.restored_published' : 'version.restored_draft', {
    versionId: id,
    from: source.id,
    fromNumber: source.number,
  });
  return getVersion(id);
}

export function editorStats() {
  const versions = db.prepare('SELECT COUNT(*) AS n FROM app_site_versions').get();
  const proposals = db.prepare("SELECT COUNT(*) AS n FROM app_site_proposals WHERE status = 'proposed'").get();
  const events = db.prepare('SELECT COUNT(*) AS n FROM app_editor_events').get();
  return {
    versions: versions ? versions.n : 0,
    openProposals: proposals ? proposals.n : 0,
    events: events ? events.n : 0,
  };
}

export function recentEvents(limit = 30) {
  return db
    .prepare('SELECT id, actor_id AS actorId, action, detail, created_at AS createdAt FROM app_editor_events ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 30, 1), 100));
}

export { applyOps };

// Create the editor tables and the baseline version as soon as the store is loaded, so no
// request can arrive before the schema exists.
ensureEditorSchema();
