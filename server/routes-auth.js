// #ash Mesh — accounts, profiles, privacy, friends, notifications, blocks, reports.
import express from 'express';
import { db, uid, now, parseJSON, toPublicUser, notify, audit, areFriends, isBlocked, DEFAULT_PRIVACY } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireAuth, rateLimit,
  validateRegistration, clean, clientIp, saveMedia, upload, randomToken, sha256, badRequest,
} from '../lib.js';

const router = express.Router();

const SESSION_USER = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function publicKeyFor(userId) {
  const row = db.prepare('SELECT public_key_jwk FROM users WHERE id = ?').get(userId);
  return parseJSON(row?.public_key_jwk, null);
}

/* ---------------------------------- auth --------------------------------- */

router.post('/auth/register', rateLimit({ name: 'register', limit: 10, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const username = clean(req.body.username, 24).toLowerCase();
  const password = String(req.body.password || '');
  const fullName = clean(req.body.fullName, 120);

  const errors = validateRegistration({ email, username, password, fullName });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'validation_failed', errors, message: 'Please correct the highlighted fields.' });

  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email)) {
    return res.status(409).json({ error: 'email_taken', errors: { email: 'An account with this email already exists.' }, message: 'Email already registered.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(username)) {
    return res.status(409).json({ error: 'username_taken', errors: { username: 'That username is taken.' }, message: 'Username already taken.' });
  }

  const id = uid('usr_');
  const founderEmail = (process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
  const isFounder = !!founderEmail && founderEmail === email;
  db.prepare(
    `INSERT INTO users (id, email, username, password_hash, full_name, privacy, role, is_founder, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, email, username, hashPassword(password), fullName, JSON.stringify(DEFAULT_PRIVACY), isFounder ? 'founder' : 'member', isFounder ? 1 : 0, now(), now());

  createSession(id, req, res);
  audit(id, 'account.register', 'user', id, {}, clientIp(req));
  res.status(201).json({ user: toPublicUser(SESSION_USER(id), id), csrfToken: req.cookies?.ash_csrf });
});

router.post('/auth/login', rateLimit({ name: 'login', limit: 15, windowMs: 15 * 60 * 1000 }), (req, res) => {
  const identifier = clean(req.body.email || req.body.identifier, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!identifier || !password) return badRequest(res, 'Enter your email/username and password.');

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?').get(identifier, identifier);
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit(user?.id || null, 'auth.login_failed', 'user', user?.id || '', { identifier }, clientIp(req));
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email/username or password.' });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'account_suspended', message: 'This account is suspended. Contact support.' });
  }
  createSession(user.id, req, res);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
  audit(user.id, 'auth.login', 'user', user.id, {}, clientIp(req));
  res.json({ user: toPublicUser(SESSION_USER(user.id), user.id), csrfToken: req.cookies?.ash_csrf });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  audit(req.user.id, 'auth.logout', 'user', req.user.id, {}, clientIp(req));
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: toPublicUser(req.user, req.user.id), csrfToken: req.session.csrfToken });
});

router.post('/auth/password/forgot', rateLimit({ name: 'forgot', limit: 5, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const identifier = clean(req.body.email, 200).toLowerCase();
  const generic = { ok: true, message: 'If that account exists, a recovery link has been created.' };
  if (!identifier) return badRequest(res, 'Enter your account email.');
  const user = db.prepare('SELECT id, email, full_name FROM users WHERE lower(email) = ?').get(identifier);
  if (!user) return res.json(generic);

  const token = randomToken(32);
  db.prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(uid('rst_'), user.id, sha256(token), new Date(Date.now() + 60 * 60 * 1000).toISOString(), now());
  audit(user.id, 'auth.password_reset_requested', 'user', user.id, {}, clientIp(req));

  const origin = `${req.protocol}://${req.get('host')}`;
  const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  const delivery = await deliverRecoveryEmail({ to: user.email, name: user.full_name, link });
  if (delivery !== 'sent') {
    // No email provider configured: the link is never silently faked. It is logged for the operator
    // and echoed only when RESET_LINK_ECHO=1 is explicitly set (local development).
    console.log(`[#ash Mesh] password recovery link for ${user.email}: ${link}`);
    if (process.env.RESET_LINK_ECHO === '1') return res.json({ ...generic, devResetLink: link, delivery: 'not_configured' });
    return res.json({ ...generic, delivery: 'not_configured' });
  }
  res.json({ ...generic, delivery: 'sent' });
});

async function deliverRecoveryEmail({ to, name, link }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return 'not_configured';
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'noreply@ashmesh.com',
        to: [to],
        subject: '#ash Mesh password recovery',
        text: `Hello ${name},\n\nReset your #ash Mesh password using this link (valid for 1 hour):\n${link}\n\nIf you did not request this, ignore this message.`,
      }),
    });
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

router.post('/auth/password/reset', rateLimit({ name: 'reset', limit: 10, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const token = clean(req.body.token, 200);
  const password = String(req.body.password || '');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return badRequest(res, 'Password must be at least 8 characters and contain letters and numbers.');
  }
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(token));
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_token', message: 'This recovery link is invalid or has expired.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  audit(row.user_id, 'auth.password_reset', 'user', row.user_id, {}, clientIp(req));
  res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
});

router.post('/auth/password/change', requireAuth, (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  const user = SESSION_USER(req.user.id);
  if (!verifyPassword(current, user.password_hash)) return res.status(401).json({ error: 'invalid_credentials', message: 'Current password is incorrect.' });
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return badRequest(res, 'New password must be at least 8 characters with letters and numbers.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  audit(user.id, 'auth.password_changed', 'user', user.id, {}, clientIp(req));
  res.json({ ok: true });
});

/* --------------------------------- profile -------------------------------- */

router.patch('/users/me', requireAuth, (req, res) => {
  const fields = {
    full_name: clean(req.body.fullName, 120),
    bio: clean(req.body.bio, 600),
    phone: clean(req.body.phone, 40),
    country: clean(req.body.country, 80),
    state: clean(req.body.state, 80),
    city: clean(req.body.city, 80),
    home_address: clean(req.body.homeAddress, 240),
    occupation: clean(req.body.occupation, 120),
    education: clean(req.body.education, 160),
    skills: clean(req.body.skills, 400),
    interests: clean(req.body.interests, 400),
    website: clean(req.body.website, 200),
    language: clean(req.body.language, 12) || 'en',
  };
  if (req.body.website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(req.body.website)) {
    return badRequest(res, 'Website must be a full URL such as https://example.com', 'validation_failed');
  }
  if (req.body.socialLinks && typeof req.body.socialLinks === 'object') {
    const links = {};
    for (const [key, value] of Object.entries(req.body.socialLinks).slice(0, 8)) {
      if (typeof value === 'string' && value.trim()) links[clean(key, 24)] = clean(value, 200);
    }
    fields.social_links = JSON.stringify(links);
  }
  if (req.body.username) {
    const username = clean(req.body.username, 24).toLowerCase();
    if (!/^[a-z0-9._]{3,24}$/.test(username)) return badRequest(res, 'Username must be 3–24 characters (letters, numbers, dot or underscore).', 'validation_failed');
    const taken = db.prepare('SELECT 1 FROM users WHERE lower(username) = ? AND id != ?').get(username, req.user.id);
    if (taken) return res.status(409).json({ error: 'username_taken', message: 'That username is taken.' });
    fields.username = username;
  }
  if (req.body.privacy && typeof req.body.privacy === 'object') {
    const current = { ...DEFAULT_PRIVACY, ...parseJSON(req.user.privacy, {}) };
    const allowed = {
      profile: ['public', 'friends', 'private'],
      phone: ['public', 'friends', 'private'],
      email: ['public', 'friends', 'private'],
      location: ['public', 'friends', 'private'],
      friendRequests: ['everyone', 'friends_of_friends', 'nobody'],
      messageRequests: ['everyone', 'friends', 'nobody'],
    };
    const privacy = { ...current };
    for (const [key, options] of Object.entries(allowed)) {
      if (req.body.privacy[key] && options.includes(req.body.privacy[key])) privacy[key] = req.body.privacy[key];
    }
    fields.privacy = JSON.stringify(privacy);
  }

  const keys = Object.keys(fields);
  if (!keys.length) return badRequest(res, 'Nothing to update.');
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), req.user.id);
  audit(req.user.id, 'profile.update', 'user', req.user.id, { fields: keys }, clientIp(req));
  res.json({ user: toPublicUser(SESSION_USER(req.user.id), req.user.id) });
});

router.post('/users/me/avatar', requireAuth, upload.single('file'), (req, res) => {
  try {
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'image' });
    db.prepare('UPDATE users SET avatar_media_id = ? WHERE id = ?').run(media.id, req.user.id);
    res.json({ avatarUrl: `/api/media/${media.id}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Upload failed.' });
  }
});

router.post('/users/me/cover', requireAuth, upload.single('file'), (req, res) => {
  try {
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'image' });
    db.prepare('UPDATE users SET cover_media_id = ? WHERE id = ?').run(media.id, req.user.id);
    res.json({ coverUrl: `/api/media/${media.id}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Upload failed.' });
  }
});

// E2E public key registration (private key never leaves the device).
router.put('/users/me/public-key', requireAuth, (req, res) => {
  const jwk = req.body.publicKey;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    return badRequest(res, 'A valid P-256 public key is required.');
  }
  db.prepare('UPDATE users SET public_key_jwk = ? WHERE id = ?').run(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }), req.user.id);
  res.json({ ok: true });
});

router.get('/users/search', requireAuth, (req, res) => {
  const q = clean(req.query.q, 80);
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(
    `SELECT * FROM users
     WHERE status = 'active' AND (lower(username) LIKE ? OR lower(full_name) LIKE ?)
       AND id != ?
       AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
       AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
     ORDER BY username LIKE ? DESC, last_seen_at DESC LIMIT 20`
  ).all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, req.user.id, req.user.id, req.user.id, `${q.toLowerCase()}%`);
  res.json({ users: rows.map((row) => ({ ...toPublicUser(row, req.user.id), relationship: relationship(req.user.id, row.id) })) });
});

router.get('/users/suggested', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM users WHERE status='active' AND id != ?
       AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
       AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
       AND id NOT IN (
         SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
         FROM friendships WHERE (requester_id = ? OR addressee_id = ?)
       )
     ORDER BY last_seen_at DESC LIMIT 8`
  ).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json({ users: rows.map((row) => toPublicUser(row, req.user.id)) });
});

function relationship(viewerId, targetId) {
  if (viewerId === targetId) return 'self';
  const block = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(viewerId, targetId);
  if (block) return 'blocked';
  const f = db.prepare(
    `SELECT status, requester_id FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`
  ).get(viewerId, targetId, targetId, viewerId);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  if (f.status === 'pending') return f.requester_id === viewerId ? 'request_sent' : 'request_received';
  return 'none';
}

router.get('/users/:username', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(clean(req.params.username, 40).toLowerCase());
  if (!row) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  const rel = relationship(req.user.id, row.id);
  if (rel === 'blocked') return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  const privacy = { ...DEFAULT_PRIVACY, ...parseJSON(row.privacy, {}) };
  const isSelf = row.id === req.user.id;
  const friend = rel === 'friends';
  if (!isSelf && privacy.profile === 'private' && !friend) {
    return res.json({
      user: { id: row.id, username: row.username, fullName: row.full_name, avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null, privacyLimited: true, relationship: rel },
    });
  }
  const user = toPublicUser(row, req.user.id);
  const visible = (level) => isSelf || level === 'public' || (level === 'friends' && friend);
  if (visible(privacy.email)) user.email = row.email;
  if (visible(privacy.phone)) user.phone = row.phone;
  if (visible(privacy.location)) {
    user.city = row.city; user.state = row.state; user.country = row.country;
    if (isSelf) user.homeAddress = row.home_address;
  } else {
    user.city = ''; user.state = ''; user.country = '';
  }
  const counts = {
    posts: db.prepare("SELECT COUNT(*) c FROM posts WHERE author_id = ? AND deleted_at IS NULL AND audience != 'private'").get(row.id).c,
    friends: db.prepare("SELECT COUNT(*) c FROM friendships WHERE status='accepted' AND (requester_id = ? OR addressee_id = ?)").get(row.id, row.id).c,
  };
  res.json({ user: { ...user, relationship: rel, counts } });
});

/* --------------------------------- friends -------------------------------- */

router.get('/friends', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT u.* FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
     WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
     ORDER BY u.full_name COLLATE NOCASE`
  ).all(req.user.id, req.user.id, req.user.id);
  res.json({ friends: rows.map((row) => toPublicUser(row, req.user.id)) });
});

router.get('/friends/requests', requireAuth, (req, res) => {
  const incoming = db.prepare(
    `SELECT f.id, f.created_at, u.* FROM friendships f JOIN users u ON u.id = f.requester_id
     WHERE f.addressee_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`
  ).all(req.user.id);
  const outgoing = db.prepare(
    `SELECT f.id, f.created_at, u.* FROM friendships f JOIN users u ON u.id = f.addressee_id
     WHERE f.requester_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`
  ).all(req.user.id);
  res.json({
    incoming: incoming.map((r) => ({ requestId: r.id, createdAt: r.created_at, user: toPublicUser(r, req.user.id) })),
    outgoing: outgoing.map((r) => ({ requestId: r.id, createdAt: r.created_at, user: toPublicUser(r, req.user.id) })),
  });
});

router.post('/friends/request', requireAuth, rateLimit({ name: 'friendreq', limit: 60, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const targetId = clean(req.body.userId, 60);
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(targetId);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  if (target.id === req.user.id) return badRequest(res, 'You cannot send a friend request to yourself.');
  if (isBlocked(req.user.id, target.id)) return res.status(403).json({ error: 'blocked', message: 'This request cannot be sent.' });

  const targetPrivacy = { ...DEFAULT_PRIVACY, ...parseJSON(target.privacy, {}) };
  if (targetPrivacy.friendRequests === 'nobody') return res.status(403).json({ error: 'not_accepting', message: 'This user is not accepting friend requests.' });
  if (targetPrivacy.friendRequests === 'friends_of_friends' && !sharedFriend(req.user.id, target.id)) {
    return res.status(403).json({ error: 'not_accepting', message: 'This user only accepts requests from friends of friends.' });
  }

  const existing = db.prepare(
    `SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`
  ).get(req.user.id, target.id, target.id, req.user.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'already_friends', message: 'You are already friends.' });
    if (existing.status === 'pending') {
      if (existing.requester_id === req.user.id) return res.status(409).json({ error: 'already_requested', message: 'Request already sent.' });
      return res.status(409).json({ error: 'request_pending', message: 'This user already sent you a request — accept it instead.' });
    }
    db.prepare("UPDATE friendships SET requester_id = ?, addressee_id = ?, status = 'pending', created_at = ?, updated_at = ? WHERE id = ?")
      .run(req.user.id, target.id, now(), now(), existing.id);
    notify(target.id, { type: 'friend_request', actorId: req.user.id, entityType: 'friendship', entityId: existing.id });
    return res.json({ ok: true, requestId: existing.id });
  }
  const id = uid('frq_');
  db.prepare("INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?)")
    .run(id, req.user.id, target.id, now(), now());
  notify(target.id, { type: 'friend_request', actorId: req.user.id, entityType: 'friendship', entityId: id });
  audit(req.user.id, 'friend.request', 'user', target.id, {}, clientIp(req));
  res.status(201).json({ ok: true, requestId: id });
});

function sharedFriend(a, b) {
  const row = db.prepare(
    `SELECT 1 FROM friendships f1 JOIN friendships f2
       ON (CASE WHEN f1.requester_id = ? THEN f1.addressee_id ELSE f1.requester_id END) =
          (CASE WHEN f2.requester_id = ? THEN f2.addressee_id ELSE f2.requester_id END)
     WHERE f1.status='accepted' AND f2.status='accepted'
       AND (f1.requester_id = ? OR f1.addressee_id = ?)
       AND (f2.requester_id = ? OR f2.addressee_id = ?) LIMIT 1`
  ).get(a, b, a, a, b, b);
  return !!row;
}

router.post('/friends/:id/accept', requireAuth, (req, res) => {
  const f = db.prepare("SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = 'pending'").get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'not_found', message: 'Request not found.' });
  db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(now(), f.id);
  notify(f.requester_id, { type: 'friend_accept', actorId: req.user.id, entityType: 'friendship', entityId: f.id });
  audit(req.user.id, 'friend.accept', 'user', f.requester_id, {}, clientIp(req));
  res.json({ ok: true });
});

router.post('/friends/:id/reject', requireAuth, (req, res) => {
  const f = db.prepare("SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = 'pending'").get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'not_found', message: 'Request not found.' });
  db.prepare('DELETE FROM friendships WHERE id = ?').run(f.id);
  audit(req.user.id, 'friend.reject', 'user', f.requester_id, {}, clientIp(req));
  res.json({ ok: true });
});

router.post('/friends/:id/cancel', requireAuth, (req, res) => {
  const f = db.prepare("SELECT * FROM friendships WHERE id = ? AND requester_id = ? AND status = 'pending'").get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'not_found', message: 'Request not found.' });
  db.prepare('DELETE FROM friendships WHERE id = ?').run(f.id);
  audit(req.user.id, 'friend.cancel', 'user', f.addressee_id, {}, clientIp(req));
  res.json({ ok: true });
});

router.delete('/friends/:userId', requireAuth, (req, res) => {
  const other = clean(req.params.userId, 60);
  const result = db.prepare(
    "DELETE FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
  ).run(req.user.id, other, other, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'not_found', message: 'Friendship not found.' });
  audit(req.user.id, 'friend.remove', 'user', other, {}, clientIp(req));
  res.json({ ok: true });
});

/* --------------------------------- blocks --------------------------------- */

router.get('/blocks', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT u.*, b.created_at AS blocked_at FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?').all(req.user.id);
  res.json({ blocks: rows.map((r) => ({ ...toPublicUser(r, req.user.id), blockedAt: r.blocked_at })) });
});

router.post('/blocks/:userId', requireAuth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  if (target.id === req.user.id) return badRequest(res, 'You cannot block yourself.');
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(req.user.id, target.id, now());
  db.prepare('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)')
    .run(req.user.id, target.id, target.id, req.user.id);
  audit(req.user.id, 'user.block', 'user', target.id, {}, clientIp(req));
  res.json({ ok: true });
});

router.delete('/blocks/:userId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, req.params.userId);
  audit(req.user.id, 'user.unblock', 'user', req.params.userId, {}, clientIp(req));
  res.json({ ok: true });
});

/* ------------------------------ notifications ----------------------------- */

router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT n.*, u.username AS actor_username, u.full_name AS actor_name, u.avatar_media_id AS actor_avatar
     FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 60`
  ).all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).c;
  res.json({
    unread,
    notifications: rows.map((r) => ({
      id: r.id, type: r.type, entityType: r.entity_type, entityId: r.entity_id,
      data: parseJSON(r.data, {}), readAt: r.read_at, createdAt: r.created_at,
      actor: r.actor_username ? { id: r.actor_id, username: r.actor_username, fullName: r.actor_name, avatarUrl: r.actor_avatar ? `/api/media/${r.actor_avatar}` : null } : null,
    })),
  });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
  res.json({ ok: true });
});

/* --------------------------------- reports -------------------------------- */

const REPORT_TARGETS = ['post', 'comment', 'user', 'listing', 'message'];

router.post('/reports', requireAuth, rateLimit({ name: 'report', limit: 30, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const targetType = clean(req.body.targetType, 20);
  const targetId = clean(req.body.targetId, 80);
  const reason = clean(req.body.reason, 60);
  const details = clean(req.body.details, 1000);
  if (!REPORT_TARGETS.includes(targetType)) return badRequest(res, 'Unknown report type.');
  if (!reason) return badRequest(res, 'Select a reason for the report.');
  const id = uid('rpt_');
  db.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, targetType, targetId, reason, details, 'open', now());
  audit(req.user.id, 'report.create', targetType, targetId, { reason }, clientIp(req));
  res.status(201).json({ ok: true, id, message: 'Report submitted for review.' });
});

router.get('/reports/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 40').all(req.user.id);
  res.json({ reports: rows });
});

/* ------------------------------ public key lookup ------------------------- */

router.get('/keys/:userId', requireAuth, (req, res) => {
  const key = publicKeyFor(req.params.userId);
  if (!key) return res.status(404).json({ error: 'no_key', message: 'This user has not set up encryption keys yet.' });
  res.json({ publicKey: key });
});

export default router;
