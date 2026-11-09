// #ash Mesh — online/offline synchronisation API.
//
// GET  /api/sync/pull   Incremental pull of everything a device keeps offline.
// POST /api/sync/push   Batch replay of operations performed while offline.
//
// Design rules that matter for correctness:
//  • Pulls are cursor-based (ISO timestamp) and use `>=` so a record written in the
//    same millisecond as the previous cursor is never skipped. Duplicates are harmless
//    because the client merges by id with last-writer-wins.
//  • Every pulled post is filtered through the same visibility rules as the feed, so
//    synchronisation can never expose a post the viewer is not allowed to see.
//  • Own deletions are returned as tombstones so a cached copy is removed instead of
//    resurrecting on the next sync.
//  • Push is idempotent per clientId: replaying the same operation returns the record
//    that already exists instead of creating a duplicate.
import express from 'express';
import { db, now, uid, toPublicUser, postVisibility, audit } from './db.js';
import { requireAuth, rateLimit, clean, badRequest } from './lib.js';
import { serializePost } from './routes-social.js';
import { serializeCourse } from './routes-content.js';
import { serializeHeritage } from './routes-heritage.js';

const router = express.Router();

const PULL_LIMIT = 300;

function ownDeletedPosts(userId, since) {
  return db
    .prepare('SELECT id, updated_at FROM posts WHERE author_id = ? AND deleted_at IS NOT NULL AND updated_at >= ? ORDER BY updated_at ASC LIMIT 200')
    .all(userId, since)
    .map((row) => ({ id: row.id, deleted: true, updatedAt: row.updated_at }));
}

function pullThreads(userId) {
  try {
    const rows = db
      .prepare(
        `SELECT c.* FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE cm.user_id = ?
         LIMIT 100`,
      )
      .all(userId);

    return rows.map((row) => {
      let lastMessageAt = null;
      let unread = 0;
      try {
        lastMessageAt = db
          .prepare('SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ?')
          .get(row.id)?.t || null;
        unread = db
          .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND sender_id != ? AND status != 'read'")
          .get(row.id, userId)?.c || 0;
      } catch {
        /* older schema without status column — keep the thread list usable */
      }
      return {
        id: row.id,
        kind: row.kind || 'direct',
        title: row.title || null,
        lastMessageAt,
        unread,
        updatedAt: row.updated_at || lastMessageAt,
      };
    });
  } catch {
    return [];
  }
}

function pullMarket(since) {
  try {
    return db
      .prepare("SELECT * FROM marketplace_listings WHERE status = 'active' AND updated_at >= ? ORDER BY updated_at ASC LIMIT 100")
      .all(since)
      .map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description || '',
        price: row.price,
        currency: row.currency || 'NGN',
        status: row.status,
        mediaUrl: row.media_id ? `/api/media/${row.media_id}` : null,
        sellerId: row.seller_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  } catch {
    return [];
  }
}

/* ---------------------------------- pull ---------------------------------- */

router.get('/sync/pull', requireAuth, (req, res) => {
  const since = clean(req.query.since, 40) || '';
  const snapshot = now();

  const visibility = postVisibility(req.user.id);
  const posts = db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE ${visibility.sql} AND p.updated_at >= ?
       ORDER BY p.updated_at ASC LIMIT ${PULL_LIMIT}`,
    )
    .all(...visibility.params, since)
    .map((row) => serializePost(row, req.user.id));

  const tombstones = ownDeletedPosts(req.user.id, since);

  let academy = [];
  try {
    academy = db
      .prepare('SELECT * FROM academy_courses WHERE deleted_at IS NULL AND published = 1 AND updated_at >= ? ORDER BY updated_at ASC LIMIT 200')
      .all(since)
      .map((row) => serializeCourse(row, req.user.id));
  } catch {
    academy = [];
  }

  let heritage = [];
  try {
    heritage = db
      .prepare('SELECT * FROM heritage_entries WHERE deleted_at IS NULL AND published = 1 AND updated_at >= ? ORDER BY updated_at ASC LIMIT 200')
      .all(since)
      .map((row) => serializeHeritage(row, req.user.id));
  } catch {
    heritage = [];
  }

  res.json({
    cursor: snapshot,
    serverTime: snapshot,
    user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), req.user.id),
    posts: [...posts, ...tombstones],
    threads: pullThreads(req.user.id),
    academy,
    heritage,
    market: pullMarket(since),
  });
});

/* ---------------------------------- push ---------------------------------- */

// Batch replay of offline social actions. Messages use /messages/sync (they carry
// E2E envelopes), so this endpoint deliberately covers posts, comments and likes.
router.post(
  '/sync/push',
  requireAuth,
  rateLimit({ name: 'sync_push', limit: 120, windowMs: 60 * 60 * 1000 }),
  (req, res) => {
    const operations = Array.isArray(req.body?.operations) ? req.body.operations.slice(0, 50) : null;
    if (!operations) return badRequest(res, 'Send an operations array.');

    const results = [];

    for (const op of operations) {
      const clientId = clean(op?.clientId, 80);
      const type = clean(op?.type, 20);

      if (!clientId || !type) {
        results.push({ clientId: clientId || null, status: 'rejected', reason: 'invalid_operation' });
        continue;
      }

      if (type === 'post') {
        const body = clean(op.body, 5000);
        if (!body) {
          results.push({ clientId, status: 'rejected', reason: 'empty_post' });
          continue;
        }
        const existing = db
          .prepare('SELECT * FROM posts WHERE author_id = ? AND client_id = ?')
          .get(req.user.id, clientId);
        if (existing) {
          results.push({ clientId, status: 'duplicate', id: existing.id, post: serializePost(existing, req.user.id) });
          continue;
        }
        const audience = ['public', 'friends', 'private'].includes(op.audience) ? op.audience : 'public';
        const id = uid('pst_');
        const ts = now();
        db.prepare(
          'INSERT INTO posts (id, author_id, body, kind, audience, client_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(id, req.user.id, body, 'text', audience, clientId, ts, ts);
        audit(req.user.id, 'post.create', 'post', id, { via: 'offline_sync', audience });
        results.push({
          clientId,
          status: 'accepted',
          id,
          post: serializePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id), req.user.id),
        });
        continue;
      }

      if (type === 'comment') {
        const postId = clean(op.postId, 60);
        const body = clean(op.body, 2000);
        const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
        if (!post || post.deleted_at) {
          results.push({ clientId, status: 'rejected', reason: 'post_unavailable' });
          continue;
        }
        const vis = postVisibility(req.user.id);
        const visible = db
          .prepare(`SELECT p.id FROM posts p WHERE p.id = ? AND ${vis.sql}`)
          .get(post.id, ...vis.params);
        if (!visible) {
          results.push({ clientId, status: 'rejected', reason: 'not_permitted' });
          continue;
        }
        if (!body) {
          results.push({ clientId, status: 'rejected', reason: 'empty_comment' });
          continue;
        }
        const existing = db
          .prepare("SELECT * FROM comments WHERE post_id = ? AND user_id = ? AND body = ? AND created_at >= datetime('now','-1 day')")
          .get(post.id, req.user.id, body);
        if (existing) {
          results.push({ clientId, status: 'duplicate', id: existing.id });
          continue;
        }
        const id = uid('cmt_');
        db.prepare('INSERT INTO comments (id, post_id, user_id, body, created_at) VALUES (?,?,?,?,?)')
          .run(id, post.id, req.user.id, body, now());
        results.push({ clientId, status: 'accepted', id });
        continue;
      }

      if (type === 'like') {
        const postId = clean(op.postId, 60);
        const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
        if (!post || post.deleted_at) {
          results.push({ clientId, status: 'rejected', reason: 'post_unavailable' });
          continue;
        }
        const liked = !!op.liked;
        const existing = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
        // Setting the desired end state is naturally idempotent.
        if (liked && !existing) {
          db.prepare('INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)').run(post.id, req.user.id, now());
        } else if (!liked && existing) {
          db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(post.id, req.user.id);
        }
        const likes = db.prepare('SELECT COUNT(*) c FROM post_likes WHERE post_id = ?').get(post.id).c;
        results.push({ clientId, status: 'accepted', id: post.id, liked, likes });
        continue;
      }

      results.push({ clientId, status: 'rejected', reason: 'unsupported_type' });
    }

    res.json({ results });
  },
);

export default router;
