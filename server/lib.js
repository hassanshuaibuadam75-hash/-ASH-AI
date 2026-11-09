// #ash Mesh — security primitives: password hashing, sessions, CSRF, rate limiting,
// validation, media validation and storage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { db, uid, now, parseJSON, audit, UPLOAD_DIR } from './db.js';

export const SESSION_COOKIE = 'ash_session';
export const CSRF_COOKIE = 'ash_csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------- passwords ------------------------------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/* -------------------------------- sessions ------------------------------- */

export function createSession(userId, req, res) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)'
  ).run(uid('ses_'), userId, sha256(token), csrf, now(), expires, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 250));
  const secure = isSecureRequest(req);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS, path: '/' });
  res.cookie(CSRF_COOKIE, csrf, { httpOnly: false, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS, path: '/' });
  return { token, csrf };
}

export function destroySession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

export function isSecureRequest(req) {
  if (process.env.FORCE_INSECURE_COOKIES === '1') return false;
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || '';
}

export function loadSession(req, _res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  req.user = null;
  req.session = null;
  if (!token) return next();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row) return next();
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return next();
  }
  req.session = { id: row.session_id, csrfToken: row.csrf_token };
  req.user = row;
  // Throttled presence update (max once per minute per user).
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 60000) {
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
  if (req.user.status === 'suspended') {
    return res.status(403).json({ error: 'account_suspended', message: 'This account is suspended. Contact support.' });
  }
  next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
    if (req.user.is_founder === 1) return next();
    const granted = parseJSON(req.user.permissions, []);
    if (req.user.role === 'admin' && (granted.includes('*') || granted.includes(permission))) return next();
    if (granted.includes(permission)) return next();
    return res.status(403).json({ error: 'permission_denied', message: 'You do not have permission for this action.' });
  };
}

export function requireFounder(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
  if (req.user.is_founder !== 1 || req.user.role !== 'founder') {
    return res.status(403).json({ error: 'founder_only', message: 'Founder authority is limited to the Founder and CEO.' });
  }
  next();
}

// Double-submit CSRF: header must match the session-bound token.
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next(); // unauthenticated endpoints (login/register) are rate limited instead
  const header = req.get('x-csrf-token') || '';
  if (!header || header !== req.session.csrfToken) {
    return res.status(403).json({ error: 'csrf_failed', message: 'Security token expired. Reload the page.' });
  }
  next();
}

/* ------------------------------- rate limits ----------------------------- */

const buckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, hits] of buckets) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

export function rateLimit({ name, limit, windowMs }) {
  return (req, res, next) => {
    const key = `${name}:${req.user?.id || clientIp(req)}`;
    const cutoff = Date.now() - windowMs;
    const hits = (buckets.get(key) || []).filter((t) => t > cutoff);
    if (hits.length >= limit) {
      const retry = Math.ceil((hits[0] + windowMs - Date.now()) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'rate_limited', message: `Too many requests. Try again in ${retry}s.` });
    }
    hits.push(Date.now());
    buckets.set(key, hits);
    next();
  };
}

/* -------------------------------- validation ----------------------------- */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
export const USERNAME_RE = /^[a-z0-9._]{3,24}$/i;

export function validateRegistration({ email, username, password, fullName }) {
  const errors = {};
  if (!email || !EMAIL_RE.test(String(email).trim())) errors.email = 'Enter a valid email address.';
  if (!username || !USERNAME_RE.test(String(username).trim())) {
    errors.username = 'Username must be 3–24 characters (letters, numbers, dot or underscore).';
  }
  if (!password || String(password).length < 8) errors.password = 'Password must be at least 8 characters.';
  else if (String(password).length > 200) errors.password = 'Password is too long.';
  else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.password = 'Password must contain letters and numbers.';
  }
  if (!fullName || String(fullName).trim().length < 2) errors.fullName = 'Enter your full name.';
  return errors;
}

export function clean(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, max);
}

export function clampInt(value, min, max, fallback = min) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function badRequest(res, message, error = 'invalid_request') {
  return res.status(400).json({ error, message });
}

/* --------------------------------- media --------------------------------- */

const KINDS = {
  image: { max: 8 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  video: { max: 64 * 1024 * 1024, mimes: ['video/mp4', 'video/webm', 'video/quicktime'] },
  audio: { max: 24 * 1024 * 1024, mimes: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav'] },
  model: { max: 40 * 1024 * 1024, mimes: ['model/gltf-binary', 'model/gltf+json', 'application/octet-stream', 'application/json'] },
  file: {
    max: 32 * 1024 * 1024,
    mimes: ['application/pdf', 'application/zip', 'text/plain', 'text/csv', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
  },
  blob: { max: 64 * 1024 * 1024, mimes: ['application/octet-stream', 'application/x-ash-cipher'] },
};

export function maxUploadBytes(kind) {
  return (KINDS[kind] || KINDS.file).max;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.bin`),
});

export const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024, files: 8 } });

function sniff(buffer) {
  const hex = buffer.toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (hex.startsWith('4f676753')) return 'audio/ogg';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('504b0304')) return 'application/zip';
  if (buffer.subarray(0, 4).toString() === 'glTF') return 'model/gltf-binary';
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 400)).trimStart();
  if (head.startsWith('{')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * Persist an uploaded temp file after validating declared kind, MIME and magic bytes.
 * Returns a media row. Throws { status, message } on rejection.
 */
export function saveMedia({ file, ownerId, kind, mime: declaredMime, encrypted = false }) {
  const spec = KINDS[kind];
  if (!spec) throw { status: 400, message: 'Unsupported upload type.' };
  if (!file) throw { status: 400, message: 'No file received.' };
  if (file.size > spec.max) {
    safeUnlink(file.path);
    throw { status: 413, message: `File is too large for ${kind} (max ${Math.round(spec.max / 1024 / 1024)}MB).` };
  }
  const head = Buffer.alloc(512);
  const fd = fs.openSync(file.path, 'r');
  const read = fs.readSync(fd, head, 0, 512, 0);
  fs.closeSync(fd);
  const sniffed = sniff(head.subarray(0, read));
  const effectiveMime = declaredMime || file.mimetype || sniffed;

  if (!encrypted) {
    const allowed = spec.mimes.includes(effectiveMime) || spec.mimes.includes(sniffed);
    if (!allowed) {
      safeUnlink(file.path);
      throw { status: 415, message: `That file type is not allowed here (${effectiveMime}).` };
    }
    if (kind === 'image' && !sniffed.startsWith('image/')) {
      safeUnlink(file.path);
      throw { status: 415, message: 'That image could not be verified as a real image file.' };
    }
    if (kind === 'model' && !['model/gltf-binary', 'application/json'].includes(sniffed)) {
      safeUnlink(file.path);
      throw { status: 415, message: '3D uploads must be .glb or .gltf files.' };
    }
    if (kind === 'video' && !['video/mp4', 'video/webm'].includes(sniffed)) {
      safeUnlink(file.path);
      throw { status: 415, message: 'Video must be MP4 or WebM.' };
    }
  }

  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file.path, { encoding: null }));
  const id = uid('med_');
  db.prepare(
    'INSERT INTO media (id, owner_id, kind, mime, size, path, sha256, encrypted, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, ownerId, kind, encrypted ? 'application/x-ash-cipher' : (effectiveMime || sniffed), file.size, file.filename, hash.digest('hex'), encrypted ? 1 : 0, now());
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id);
}

export function safeUnlink(filePath) {
  try {
    if (filePath) fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

export function mediaAbsolutePath(media) {
  const resolved = path.resolve(UPLOAD_DIR, media.path);
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) return null;
  return resolved;
}

/** Central access check for every stored file. */
export function canAccessMedia(media, viewerId) {
  if (!media) return false;
  if (viewerId && media.owner_id === viewerId) return true;

  const asAvatar = db
    .prepare('SELECT 1 FROM users WHERE (avatar_media_id = ? OR cover_media_id = ?) AND status = ?')
    .get(media.id, media.id, 'active');
  if (asAvatar) return true;

  if (media.encrypted === 1) {
    const message = db
      .prepare('SELECT conversation_id FROM messages WHERE media_id = ?')
      .get(media.id);
    if (!message) return false;
    const member = db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(message.conversation_id, viewerId);
    return !!member;
  }

  const post = db
    .prepare("SELECT * FROM posts WHERE media_id = ? AND deleted_at IS NULL AND audience != 'private'")
    .get(media.id);
  if (post) {
    if (post.audience === 'public') return true;
    const friend = db
      .prepare(
        `SELECT 1 FROM friendships WHERE status='accepted'
         AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`
      )
      .get(post.author_id, viewerId, viewerId, post.author_id);
    return !!friend;
  }

  const listing = db
    .prepare("SELECT 1 FROM marketplace_listings WHERE status IN ('active','sold') AND media LIKE ?")
    .get(`%"${media.id}"%`);
  if (listing) return true;

  const doc = db
    .prepare('SELECT 1 FROM seller_verifications WHERE doc_media_id = ?')
    .get(media.id);
  if (doc) {
    if (!viewerId) return false;
    const viewer = db.prepare('SELECT role, permissions, is_founder FROM users WHERE id = ?').get(viewerId);
    if (!viewer) return false;
    if (viewer.is_founder === 1) return true;
    return parseJSON(viewer.permissions, []).some((p) => ['moderation.view', 'verification.review', '*'].includes(p));
  }

  return false;
}

export function logModeration(actorId, action, targetType, targetId, meta, ip) {
  audit(actorId, action, targetType, targetId, meta, ip);
}
