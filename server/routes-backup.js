// #ash Mesh — Founder-only data durability API.
//
// Every route is guarded by requireFounder, which reads the authenticated account's
// is_founder flag from the database. A name, username or chat claim is never consulted.
// Restore is destructive by nature, so it is rate limited and audited, and the module
// always writes a pre-restore safety snapshot first.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { requireFounder, rateLimit, clientIp } from './lib.js';
import {
  adoptUploadedBackup,
  backupStatus,
  buildArchive,
  createBackup,
  listBackups,
  resolveBackupPath,
  restoreArchive,
  restoreBackup,
  verifyBackup,
} from './backup.js';

const router = express.Router();

const restoreStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, _file, cb) => cb(null, `ash-mesh-restore-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`),
});
const restoreUpload = multer({ storage: restoreStorage, limits: { fileSize: 256 * 1024 * 1024, files: 1 } });

// An export archive carries the database and every uploaded file, so it is larger than a bare
// .db snapshot. It is still capped, and the archive reader enforces its own per-entry limits.
const archiveStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, _file, cb) => cb(null, `ash-mesh-archive-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.zip`),
});
const archiveUpload = multer({ storage: archiveStorage, limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });

function singleZipFile(req, res, next) {
  archiveUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'payload_too_large', message: 'An export archive up to 1GB can be restored.' });
    }
    return res.status(400).json({ error: 'invalid_upload', message: 'That archive could not be uploaded.' });
  });
}

function singleDbFile(req, res, next) {
  restoreUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'payload_too_large', message: 'A database file up to 256MB can be restored.' });
    }
    return res.status(400).json({ error: 'invalid_upload', message: 'That file could not be uploaded.' });
  });
}

const wrap = (handler) => (req, res, next) => {
  try {
    const result = handler(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

const createLimit = rateLimit({ name: 'backup-create', limit: 30, windowMs: 60 * 60 * 1000 });
const restoreLimit = rateLimit({ name: 'backup-restore', limit: 10, windowMs: 60 * 60 * 1000 });
const exportLimit = rateLimit({ name: 'backup-export', limit: 10, windowMs: 60 * 60 * 1000 });

router.get(
  '/founder/backups',
  requireFounder,
  wrap((_req, res) => {
    res.json({ ...backupStatus(), backups: listBackups() });
  })
);

router.post(
  '/founder/backups',
  requireFounder,
  createLimit,
  wrap((req, res) => {
    const backup = createBackup({ reason: 'manual', actorId: req.user.id });
    res.status(201).json({ backup });
  })
);

router.get(
  '/founder/backups/:name/download',
  requireFounder,
  wrap((req, res, next) => {
    const file = resolveBackupPath(req.params.name);
    res.download(file, req.params.name, (err) => {
      if (err && !res.headersSent) next(err);
    });
  })
);

router.post(
  '/founder/backups/:name/verify',
  requireFounder,
  wrap((req, res) => {
    res.json({ verification: verifyBackup(req.params.name) });
  })
);

router.post(
  '/founder/backups/restore-upload',
  requireFounder,
  restoreLimit,
  singleDbFile,
  wrap((req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file_required', message: 'Choose a .db backup file to restore.' });
    try {
      const adopted = adoptUploadedBackup(req.file.path, { actorId: req.user.id });
      const restore = restoreBackup(adopted.name, {
        actorId: req.user.id,
        sessionId: req.session?.id,
        ip: clientIp(req),
        source: 'upload',
      });
      res.json({ adopted: { name: adopted.name, sha256: adopted.sha256, rows: adopted.rows }, restore });
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  })
);

router.post(
  '/founder/backups/:name/restore',
  requireFounder,
  restoreLimit,
  wrap((req, res) => {
    const restore = restoreBackup(req.params.name, {
      actorId: req.user.id,
      sessionId: req.session?.id,
      ip: clientIp(req),
      source: 'stored',
    });
    res.json({ restore });
  })
);

router.get(
  '/founder/export',
  requireFounder,
  exportLimit,
  wrap((req, res, next) => {
    const archive = buildArchive({ actorId: req.user.id });
    res.download(archive.path, archive.name, (err) => {
      fs.rmSync(archive.path, { force: true });
      if (err && !res.headersSent) next(err);
    });
  })
);

router.post(
  '/founder/export/restore',
  requireFounder,
  restoreLimit,
  singleZipFile,
  wrap((req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file_required', message: 'Choose an .zip export archive to restore.' });
    try {
      const restore = restoreArchive(req.file.path, {
        actorId: req.user.id,
        sessionId: req.session?.id,
        ip: clientIp(req),
        filename: req.file.originalname || '',
      });
      res.json({ restore });
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  })
);

export default router;
