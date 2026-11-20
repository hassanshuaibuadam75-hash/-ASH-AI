// #ash Mesh — navigation counters.
//
// Every badge in the navigation comes from a real query. Nothing is hardcoded, and a
// counter with no underlying activity returns 0 so the client can hide it.
import express from 'express';
import { db } from './db.js';
import { requireAuth } from './lib.js';

const router = express.Router();

router.get('/nav/counters', requireAuth, (req, res) => {
  const me = req.user.id;

  const friendRequests = db.prepare(
    "SELECT COUNT(*) c FROM friendships WHERE addressee_id = ? AND status = 'pending'"
  ).get(me).c;

  const unreadMessages = db.prepare(
    `SELECT COUNT(*) c FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     WHERE m.sender_id != ? AND m.status != 'read'`
  ).get(me, me).c;

  const unreadNotifications = db.prepare(
    'SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL'
  ).get(me).c;

  // "Video" shows how many new video posts appeared in the last week from other people.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const newVideos = db.prepare(
    `SELECT COUNT(*) c FROM posts
     WHERE kind = 'video' AND deleted_at IS NULL AND audience = 'public'
       AND author_id != ? AND created_at > ?
       AND (moderation_status IS NULL OR moderation_status = 'visible')`
  ).get(me, since).c;

  // Groups are not implemented, so the client is told so explicitly instead of rendering
  // an empty Groups destination that leads nowhere.
  res.json({
    friendRequests,
    unreadMessages,
    unreadNotifications,
    newVideos,
    groups: { available: false },
    generatedAt: new Date().toISOString(),
  });
});

export default router;
