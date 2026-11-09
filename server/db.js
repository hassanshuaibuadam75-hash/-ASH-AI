// #ash Mesh — data layer. Real SQLite database with WAL journaling.
// All tables come from server/schema.sql; no sample/seed rows are ever inserted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ash-mesh.db');
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

export const uid = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '');
export const now = () => new Date().toISOString();

export function parseJSON(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function toPublicUser(row, viewerId = null) {
  if (!row) return null;
  const privacy = { profile: 'public', phone: 'friends', email: 'private', location: 'friends', ...parseJSON(row.privacy, {}) };
  const isSelf = viewerId && viewerId === row.id;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    bio: row.bio,
    avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null,
    coverUrl: row.cover_media_id ? `/api/media/${row.cover_media_id}` : null,
    country: row.country,
    state: row.state,
    city: row.city,
    occupation: row.occupation,
    education: row.education,
    skills: row.skills,
    interests: row.interests,
    website: row.website,
    socialLinks: parseJSON(row.social_links, {}),
    language: row.language,
    role: row.role,
    isFounder: !!row.is_founder,
    isVerifiedSeller: !!row.is_verified_seller,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    privacy: isSelf ? privacy : undefined,
    ...(isSelf
      ? {
          email: row.email,
          phone: row.phone,
          homeAddress: row.home_address,
          permissions: parseJSON(row.permissions, []),
          publicKey: parseJSON(row.public_key_jwk, null),
        }
      : {}),
    ...(privacy.profile === 'public' || isSelf
      ? {}
      : { bio: '', occupation: '', education: '', skills: '', interests: '', website: '' }),
  };
}

export const DEFAULT_PRIVACY = {
  profile: 'public', // public | friends | private
  phone: 'friends', // public | friends | private
  email: 'private',
  location: 'friends',
  friendRequests: 'everyone', // everyone | friends_of_friends | nobody
  messageRequests: 'everyone', // everyone | friends | nobody
};

// Founder bootstrap: the account matching FOUNDER_EMAIL becomes the sole founder.
// No account is fabricated; if the variable is unset no founder exists yet.
export function ensureFounder() {
  const email = (process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const user = db.prepare('SELECT id, role, is_founder FROM users WHERE lower(email) = ?').get(email);
  if (!user) return;
  if (!user.is_founder) {
    db.prepare("UPDATE users SET role = 'founder', is_founder = 1 WHERE id = ?").run(user.id);
    console.log(`[#ash Mesh] Founder authority bound to account ${user.id}`);
  }
}

export function isFounder(user) {
  if (!user) return false;
  const row = db.prepare('SELECT is_founder, role FROM users WHERE id = ?').get(user.id);
  return !!row && row.is_founder === 1 && row.role === 'founder';
}

export function audit(actorId, action, targetType = '', targetId = '', meta = {}, ip = '') {
  db.prepare(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta, ip, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(uid('aud_'), actorId || null, action, targetType, targetId, JSON.stringify(meta || {}), ip || '', now());
}

export function notify(userId, { type, actorId = null, entityType = '', entityId = '', data = {} }) {
  if (!userId || userId === actorId) return;
  db.prepare(
    'INSERT INTO notifications (id, user_id, type, actor_id, entity_type, entity_id, data, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(uid('ntf_'), userId, type, actorId, entityType, entityId, JSON.stringify(data), now());
}

export function areFriends(a, b) {
  if (!a || !b || a === b) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .get(a, b, b, a);
  return !!row;
}

export function isBlocked(a, b) {
  if (!a || !b) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM blocks
       WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
    )
    .get(a, b, b, a);
  return !!row;
}

// Returns SQL fragment + params limiting posts to what `viewerId` may see.
export function postVisibility(viewerId) {
  return {
    sql: `(
      p.deleted_at IS NULL AND (
        p.audience = 'public'
        OR p.author_id = ?
        OR (p.audience = 'friends' AND EXISTS (
          SELECT 1 FROM friendships f WHERE f.status = 'accepted'
            AND ((f.requester_id = p.author_id AND f.addressee_id = ?)
              OR (f.addressee_id = p.author_id AND f.requester_id = ?))
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = p.author_id)
          OR (b.blocker_id = p.author_id AND b.blocked_id = ?)
      )
    )`,
    params: [viewerId, viewerId, viewerId, viewerId, viewerId],
  };
}
