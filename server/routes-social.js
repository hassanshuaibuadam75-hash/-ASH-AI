// #ash Mesh — posts, media, likes, comments, shares.
import express from 'express';
import fs from 'node:fs';
import { db, uid, now, parseJSON, toPublicUser, notify, audit, areFriends, isBlocked, postVisibility } from './db.js';
import { screenContent } from './moderation.js';
import {
  requireAuth, upload, saveMedia, canAccessMedia, mediaAbsolutePath, rateLimit, clean, clampInt, badRequest, clientIp,
} from './lib.js';

const router = express.Router();
const AUDIENCES = ['public', 'friends', 'private'];

export function serializePost(row, viewerId) {
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  const liked = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(row.id, viewerId);
  const counts = {
    likes: db.prepare('SELECT COUNT(*) c FROM post_likes WHERE post_id = ?').get(row.id).c,
    comments: db.prepare('SELECT COUNT(*) c FROM comments WHERE post_id = ? AND deleted_at IS NULL').get(row.id).c,
    shares: db.prepare('SELECT COUNT(*) c FROM posts WHERE shared_post_id = ? AND deleted_at IS NULL').get(row.id).c,
  };
  let shared = null;
  if (row.shared_post_id) {
    const original = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.shared_post_id);
    if (original) {
      shared = {
        id: original.id,
        body: original.body,
        kind: original.kind,
        mediaUrl: original.media_id ? `/api/media/${original.media_id}` : null,
        deleted: !!original.deleted_at,
        author: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(original.author_id), viewerId),
      };
    }
  }
  return {
    id: row.id,
    body: row.body,
    kind: row.kind,
    audience: row.audience,
    mediaUrl: row.media_id ? `/api/media/${row.media_id}` : null,
    mediaId: row.media_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.updated_at !== row.created_at,
    author: { ...toPublicUser(author, viewerId), isAi: !!author.is_ai },
    aiGenerated: !!row.ai_generated,
    moderationStatus: row.moderation_status || 'visible',
    likedByMe: !!liked,
    counts,
    sharedPost: shared,
    isOwner: row.author_id === viewerId,
  };
}

function canViewPost(post, viewerId) {
  if (!post || post.deleted_at) return false;
  if (post.author_id === viewerId) return true;
  if (isBlocked(viewerId, post.author_id)) return false;
  if (post.audience === 'public') return true;
  if (post.audience === 'friends') return areFriends(viewerId, post.author_id);
  return false;
}

/* ---------------------------------- feed ---------------------------------- */

router.get('/feed', requireAuth, (req, res) => {
  const limit = clampInt(req.query.limit, 1, 30, 10);
  const cursor = clean(req.query.cursor, 60);
  const scope = clean(req.query.scope, 12);
  const vis = postVisibility(req.user.id);
  let where = vis.sql;
  const params = [...vis.params];

  if (scope === 'following') {
    where += ` AND (p.author_id = ? OR p.author_id IN (
      SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END FROM friendships
      WHERE status='accepted' AND (requester_id = ? OR addressee_id = ?)))`;
    params.push(req.user.id, req.user.id, req.user.id, req.user.id);
  }
  if (cursor) {
    where += ' AND p.created_at < ?';
    params.push(cursor);
  }

  // Quarantined or removed content is hidden from everyone except its author (who sees a
  // notice) and staff, who decide in the moderation queue. Nothing is deleted.
  where += " AND (p.moderation_status IS NULL OR p.moderation_status = 'visible' OR p.author_id = ?)";
  params.push(req.user.id);

  const rows = db.prepare(
    `SELECT p.* FROM posts p WHERE ${where} ORDER BY p.created_at DESC LIMIT ?`
  ).all(...params, limit);

  res.json({
    posts: rows.map((row) => serializePost(row, req.user.id)),
    nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null,
  });
});

router.get('/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canViewPost(post, req.user.id)) return res.status(404).json({ error: 'not_found', message: 'Post not available.' });
  res.json({ post: serializePost(post, req.user.id) });
});

router.get('/users/:username/posts', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(clean(req.params.username, 40).toLowerCase());
  if (!user) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  const vis = postVisibility(req.user.id);
  const rows = db.prepare(
    `SELECT p.* FROM posts p WHERE ${vis.sql} AND p.author_id = ? ORDER BY p.created_at DESC LIMIT 30`
  ).all(...vis.params, user.id);
  res.json({ posts: rows.map((row) => serializePost(row, req.user.id)) });
});

/* -------------------------------- publishing ------------------------------ */

router.post('/posts', requireAuth, rateLimit({ name: 'post', limit: 40, windowMs: 60 * 60 * 1000 }), upload.single('file'), (req, res) => {
  const body = clean(req.body.body, 5000);
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'public';
  const sharedPostId = clean(req.body.sharedPostId, 60) || null;
  // Offline replay is idempotent: the same device id never creates a second post.
  const clientId = clean(req.body.clientId, 80) || null;
  if (clientId) {
    const existing = db.prepare('SELECT * FROM posts WHERE author_id = ? AND client_id = ?').get(req.user.id, clientId);
    if (existing) return res.status(200).json({ post: serializePost(existing, req.user.id), duplicate: true });
  }

  if (!body && !req.file && !sharedPostId) {
    return badRequest(res, 'Write something or attach a file to publish.');
  }

  let media = null;
  let kind = 'text';
  if (req.file) {
    try {
      const declared = clean(req.body.mediaKind, 20) || 'file';
      const kindMap = { image: 'image', video: 'video', model: 'model', file: 'file', audio: 'audio' };
      const mediaKind = kindMap[declared] || 'file';
      media = saveMedia({ file: req.file, ownerId: req.user.id, kind: mediaKind });
      kind = mediaKind === 'audio' ? 'file' : mediaKind;
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Upload failed.' });
    }
  }
  if (sharedPostId && !media) kind = 'share';
  if (sharedPostId) {
    const original = db.prepare('SELECT * FROM posts WHERE id = ?').get(sharedPostId);
    if (!original || !canViewPost(original, req.user.id)) return res.status(404).json({ error: 'not_found', message: 'The original post is not available.' });
  }

  const id = uid('pst_');
  db.prepare('INSERT INTO posts (id, author_id, body, kind, audience, media_id, shared_post_id, client_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, body, kind, audience, media?.id || null, sharedPostId, clientId, now(), now());

  if (sharedPostId) {
    const original = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(sharedPostId);
    if (original) notify(original.author_id, { type: 'post_share', actorId: req.user.id, entityType: 'post', entityId: id });
  }
  audit(req.user.id, 'post.create', 'post', id, { kind, audience }, clientIp(req));
  res.status(201).json({ post: serializePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id), req.user.id) });
});

router.patch('/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_found', message: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'forbidden', message: 'You can only edit your own posts.' });
  const body = req.body.body !== undefined ? clean(req.body.body, 5000) : post.body;
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : post.audience;
  if (!body && !post.media_id) return badRequest(res, 'A post needs text or media.');
  db.prepare('UPDATE posts SET body = ?, audience = ?, updated_at = ? WHERE id = ?').run(body, audience, now(), post.id);
  audit(req.user.id, 'post.edit', 'post', post.id, {}, clientIp(req));
  res.json({ post: serializePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id), req.user.id) });
});

// Deletion is a soft delete (auditable, recoverable by moderation) and requires an explicit
// confirmation flag from the client. Accidental single clicks cannot destroy content.
router.delete('/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_found', message: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'forbidden', message: 'You can only delete your own posts.' });
  if (req.body?.confirm !== true && req.query.confirm !== 'true') {
    return res.status(428).json({ error: 'confirmation_required', message: 'Confirm deletion of this post.' });
  }
  db.prepare('UPDATE posts SET deleted_at = ? WHERE id = ?').run(now(), post.id);
  audit(req.user.id, 'post.delete', 'post', post.id, {}, clientIp(req));
  res.json({ ok: true });
});

/* ---------------------------------- likes --------------------------------- */

router.post('/posts/:id/like', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canViewPost(post, req.user.id)) return res.status(404).json({ error: 'not_found', message: 'Post not available.' });
  const existing = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
  if (existing) {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(post.id, req.user.id);
  } else {
    db.prepare('INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)').run(post.id, req.user.id, now());
    notify(post.author_id, { type: 'post_like', actorId: req.user.id, entityType: 'post', entityId: post.id });
  }
  res.json({
    liked: !existing,
    likes: db.prepare('SELECT COUNT(*) c FROM post_likes WHERE post_id = ?').get(post.id).c,
  });
});

router.get('/posts/:id/likes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT u.* FROM post_likes l JOIN users u ON u.id = l.user_id WHERE l.post_id = ? ORDER BY l.created_at DESC LIMIT 50').all(req.params.id);
  res.json({ users: rows.map((row) => toPublicUser(row, req.user.id)) });
});

/* -------------------------------- comments -------------------------------- */

router.get('/posts/:id/comments', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canViewPost(post, req.user.id)) return res.status(404).json({ error: 'not_found', message: 'Post not available.' });
  const rows = db.prepare(
    `SELECT c.*, u.username, u.full_name, u.avatar_media_id FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC LIMIT 200`
  ).all(post.id);
  res.json({
    comments: rows.map((r) => ({
      id: r.id, body: r.body, createdAt: r.created_at, isOwner: r.author_id === req.user.id,
      author: { id: r.author_id, username: r.username, fullName: r.full_name, avatarUrl: r.avatar_media_id ? `/api/media/${r.avatar_media_id}` : null },
    })),
  });
});

router.post('/posts/:id/comments', requireAuth, rateLimit({ name: 'comment', limit: 120, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canViewPost(post, req.user.id)) return res.status(404).json({ error: 'not_found', message: 'Post not available.' });
  const body = clean(req.body.body, 2000);
  if (!body) return badRequest(res, 'Write a comment first.');
  const id = uid('cmt_');
  db.prepare('INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?,?,?,?,?)').run(id, post.id, req.user.id, body, now());
  notify(post.author_id, { type: 'post_comment', actorId: req.user.id, entityType: 'post', entityId: post.id, data: { excerpt: body.slice(0, 120) } });
  res.status(201).json({
    comment: {
      id, body, createdAt: now(), isOwner: true,
      author: { id: req.user.id, username: req.user.username, fullName: req.user.full_name, avatarUrl: req.user.avatar_media_id ? `/api/media/${req.user.avatar_media_id}` : null },
    },
  });
});

router.delete('/comments/:id', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'not_found', message: 'Comment not found.' });
  const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(comment.post_id);
  const isModerator = req.user.is_founder === 1 || parseJSON(req.user.permissions, []).includes('moderation.content');
  if (comment.author_id !== req.user.id && post?.author_id !== req.user.id && !isModerator) {
    return res.status(403).json({ error: 'forbidden', message: 'You cannot remove this comment.' });
  }
  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now(), comment.id);
  audit(req.user.id, 'comment.delete', 'comment', comment.id, {}, clientIp(req));
  res.json({ ok: true });
});

/* --------------------------------- sharing -------------------------------- */

router.post('/posts/:id/share', requireAuth, rateLimit({ name: 'share', limit: 60, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !canViewPost(post, req.user.id)) return res.status(404).json({ error: 'not_found', message: 'Post not available.' });
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'public';
  const body = clean(req.body.body, 1000);
  const id = uid('pst_');
  db.prepare('INSERT INTO posts (id, author_id, body, kind, audience, shared_post_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, body, 'share', audience, post.id, now(), now());
  notify(post.author_id, { type: 'post_share', actorId: req.user.id, entityType: 'post', entityId: id });
  res.status(201).json({ post: serializePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id), req.user.id) });
});

/* ---------------------------------- media --------------------------------- */

router.get('/media/:id', requireAuth, (req, res) => {
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'not_found', message: 'File not found.' });
  if (!canAccessMedia(media, req.user.id)) return res.status(403).json({ error: 'forbidden', message: 'You cannot access this file.' });
  const absolute = mediaAbsolutePath(media);
  if (!absolute || !fs.existsSync(absolute)) return res.status(404).json({ error: 'not_found', message: 'File missing from storage.' });

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=86400');
  const inline = media.encrypted !== 1 && ['image/', 'video/', 'audio/'].some((p) => media.mime.startsWith(p));
  res.set('Content-Type', media.encrypted === 1 ? 'application/octet-stream' : media.mime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${media.id}${extensionFor(media.mime)}"`);
  fs.createReadStream(absolute).pipe(res);
});

function extensionFor(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/webm': '.webm', 'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'application/pdf': '.pdf', 'model/gltf-binary': '.glb',
  };
  return map[mime] || '';
}

export default router;
