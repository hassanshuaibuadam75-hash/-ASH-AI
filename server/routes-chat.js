// #ash Mesh — private messaging. The server stores AES-GCM ciphertext envelopes only;
// it has no access to conversation keys or plaintext. Attachments are stored encrypted too.
import express from 'express';
import { db, uid, now, parseJSON, toPublicUser, notify, audit, isBlocked, areFriends, DEFAULT_PRIVACY } from './db.js';
import { requireAuth, upload, saveMedia, rateLimit, clean, clampInt, badRequest, clientIp } from './lib.js';

const router = express.Router();

const MAX_ENVELOPE = 200_000;

function validEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  const { v, iv, ct, salt } = envelope;
  if (v !== 1 || typeof iv !== 'string' || typeof ct !== 'string' || typeof salt !== 'string') return false;
  if (iv.length < 12 || iv.length > 64 || salt.length < 16 || ct.length < 8) return false;
  return JSON.stringify(envelope).length <= MAX_ENVELOPE;
}

function memberOf(conversationId, userId) {
  return !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
}

function serializeMessage(row, viewerId) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    kind: row.kind,
    envelope: parseJSON(row.envelope, null),
    mediaUrl: row.media_id ? `/api/media/${row.media_id}` : null,
    status: row.status,
    transport: row.transport,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    mine: row.sender_id === viewerId,
  };
}

/* ------------------------------ conversations ----------------------------- */

router.get('/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, cm.last_read_at,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.status != 'read') AS unread
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 100`
  ).all(req.user.id, req.user.id);

  const conversations = rows.map((row) => {
    const peers = db.prepare(
      `SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ? AND cm.user_id != ?`
    ).all(row.id, req.user.id);
    const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(row.id);
    return {
      id: row.id,
      unread: row.unread,
      lastReadAt: row.last_read_at,
      lastMessageAt: row.last_message_at,
      peers: peers.map((p) => toPublicUser(p, req.user.id)),
      lastMessage: last ? serializeMessage(last, req.user.id) : null,
    };
  });
  res.json({ conversations });
});

router.post('/conversations', requireAuth, rateLimit({ name: 'conv', limit: 60, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const peerId = clean(req.body.userId, 60);
  const peer = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(peerId);
  if (!peer) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  if (peer.id === req.user.id) return badRequest(res, 'You cannot start a conversation with yourself.');
  if (isBlocked(req.user.id, peer.id)) return res.status(403).json({ error: 'blocked', message: 'This conversation is not available.' });

  const peerPrivacy = { ...DEFAULT_PRIVACY, ...parseJSON(peer.privacy, {}) };
  const friend = areFriends(req.user.id, peer.id);
  if (peerPrivacy.messageRequests === 'nobody' && !friend) {
    return res.status(403).json({ error: 'not_accepting', message: 'This user is not accepting new conversations.' });
  }
  if (peerPrivacy.messageRequests === 'friends' && !friend) {
    return res.status(403).json({ error: 'friends_only', message: 'This user only accepts messages from friends.' });
  }

  const existing = db.prepare(
    `SELECT c.id FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
     WHERE c.kind = 'direct' LIMIT 1`
  ).get(req.user.id, peer.id);
  if (existing) return res.json({ conversationId: existing.id, existing: true });

  const id = uid('cnv_');
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO conversations (id, kind, created_at) VALUES (?,?,?)').run(id, 'direct', ts);
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(id, req.user.id, ts);
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)').run(id, peer.id, ts);
  });
  tx();
  audit(req.user.id, 'conversation.create', 'conversation', id, {}, clientIp(req));
  res.status(201).json({ conversationId: id, existing: false });
});

router.get('/conversations/:id/messages', requireAuth, (req, res) => {
  if (!memberOf(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden', message: 'You are not part of this conversation.' });
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const before = clean(req.query.before, 40);
  const rows = db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? ${before ? 'AND created_at < ?' : ''}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...(before ? [req.params.id, before, limit] : [req.params.id, limit]));

  // Mark inbound messages delivered (device acknowledged by fetching them).
  const undelivered = rows.filter((r) => r.sender_id !== req.user.id && r.status === 'sent');
  if (undelivered.length) {
    const stmt = db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?");
    const ts = now();
    const tx = db.transaction(() => undelivered.forEach((r) => stmt.run(ts, r.id)));
    tx();
  }
  res.json({
    messages: rows.reverse().map((r) => serializeMessage(r, req.user.id)),
    nextCursor: rows.length === limit ? rows[0]?.created_at : null,
  });
});

function insertMessage({ conversationId, senderId, clientId, kind, envelope, mediaId, transport }) {
  const existing = db.prepare('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?').get(senderId, clientId);
  if (existing) return { message: existing, duplicate: true };
  const id = uid('msg_');
  const ts = now();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_id, client_id, kind, envelope, media_id, status, transport, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, conversationId, senderId, clientId, kind, JSON.stringify(envelope), mediaId || null, 'sent', transport || 'internet', ts);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, conversationId);
  const peers = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?').all(conversationId, senderId);
  peers.forEach((p) => notify(p.user_id, { type: 'message', actorId: senderId, entityType: 'conversation', entityId: conversationId, data: { kind } }));
  return { message: db.prepare('SELECT * FROM messages WHERE id = ?').get(id), duplicate: false };
}

router.post('/conversations/:id/messages', requireAuth, rateLimit({ name: 'message', limit: 300, windowMs: 60 * 60 * 1000 }), (req, res) => {
  if (!memberOf(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden', message: 'You are not part of this conversation.' });
  const peerIds = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?').all(req.params.id, req.user.id);
  if (peerIds.some((p) => isBlocked(req.user.id, p.user_id))) return res.status(403).json({ error: 'blocked', message: 'This conversation is not available.' });

  const clientId = clean(req.body.clientId, 80);
  if (!clientId) return badRequest(res, 'A client message id is required.');
  const envelope = req.body.envelope;
  if (!validEnvelope(envelope)) return badRequest(res, 'Message must be an encrypted envelope. Plaintext is never accepted.');
  const kind = ['text', 'image', 'video', 'audio', 'file'].includes(req.body.kind) ? req.body.kind : 'text';
  const mediaId = clean(req.body.mediaId, 60) || null;
  if (mediaId) {
    const media = db.prepare('SELECT * FROM media WHERE id = ? AND owner_id = ? AND encrypted = 1').get(mediaId, req.user.id);
    if (!media) return res.status(403).json({ error: 'invalid_media', message: 'Encrypted attachment not found for this account.' });
  }
  const transport = ['internet', 'nearby', 'queued'].includes(req.body.transport) ? req.body.transport : 'internet';
  const { message, duplicate } = insertMessage({ conversationId: req.params.id, senderId: req.user.id, clientId, kind, envelope, mediaId, transport });
  res.status(duplicate ? 200 : 201).json({ message: serializeMessage(message, req.user.id), duplicate });
});

// Batch flush of the device's offline queue. Idempotent per (sender, clientId).
router.post('/messages/sync', requireAuth, rateLimit({ name: 'sync', limit: 120, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const items = Array.isArray(req.body.messages) ? req.body.messages.slice(0, 100) : [];
  const results = [];
  for (const item of items) {
    const clientId = clean(item.clientId, 80);
    const conversationId = clean(item.conversationId, 60);
    if (!clientId || !conversationId || !memberOf(conversationId, req.user.id) || !validEnvelope(item.envelope)) {
      results.push({ clientId, status: 'rejected', reason: 'invalid_or_not_permitted' });
      continue;
    }
    const kind = ['text', 'image', 'video', 'audio', 'file'].includes(item.kind) ? item.kind : 'text';
    const mediaId = clean(item.mediaId, 60) || null;
    try {
      const { message, duplicate } = insertMessage({
        conversationId, senderId: req.user.id, clientId, kind, envelope: item.envelope, mediaId,
        transport: item.transport === 'nearby' ? 'nearby' : 'queued',
      });
      results.push({ clientId, status: 'accepted', duplicate, messageId: message.id, createdAt: message.created_at });
    } catch {
      results.push({ clientId, status: 'rejected', reason: 'insert_failed' });
    }
  }
  res.json({ results });
});

router.post('/conversations/:id/read', requireAuth, (req, res) => {
  if (!memberOf(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden', message: 'You are not part of this conversation.' });
  const ts = now();
  db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(ts, req.params.id, req.user.id);
  db.prepare("UPDATE messages SET status = 'read', read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE conversation_id = ? AND sender_id != ? AND status != 'read'")
    .run(ts, ts, req.params.id, req.user.id);
  res.json({ ok: true, readAt: ts });
});

// Encrypted attachment upload (ciphertext produced on the device).
router.post('/conversations/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
  if (!memberOf(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden', message: 'You are not part of this conversation.' });
  try {
    const media = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'blob', encrypted: true });
    res.status(201).json({ mediaId: media.id, size: media.size, mime: media.mime });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Attachment upload failed.' });
  }
});

router.delete('/messages/:id', requireAuth, (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!message) return res.status(404).json({ error: 'not_found', message: 'Message not found.' });
  if (message.sender_id !== req.user.id) return res.status(403).json({ error: 'forbidden', message: 'You can only delete your own messages.' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  audit(req.user.id, 'message.delete', 'message', message.id, {}, clientIp(req));
  res.json({ ok: true });
});

/* ------------------------- Universal Adaptive Routing --------------------- */

router.post('/uar/telemetry', requireAuth, rateLimit({ name: 'uar', limit: 240, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const transport = clean(req.body.transport, 20);
  const allowed = ['internet', 'nearby', 'wifi_aware', 'wifi_direct', 'ble', 'lora', 'queued'];
  if (!allowed.includes(transport)) return badRequest(res, 'Unknown transport.');
  const battery = req.body.battery === null || req.body.battery === undefined ? null : clampInt(req.body.battery, 0, 100, null);
  const available = Array.isArray(req.body.available) ? req.body.available.slice(0, 10).map((v) => clean(v, 20)) : [];
  db.prepare('INSERT INTO uar_telemetry (id, user_id, transport, battery, available, created_at) VALUES (?,?,?,?,?,?)')
    .run(uid('uar_'), req.user.id, transport, battery, JSON.stringify(available), now());
  res.json({ ok: true });
});

router.get('/uar/relay', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM relay_consents WHERE user_id = ?').get(req.user.id);
  res.json({
    relay: row
      ? { enabled: !!row.enabled, allowCellular: !!row.allow_cellular, maxBatteryDrain: row.max_battery_drain, updatedAt: row.updated_at }
      : { enabled: false, allowCellular: false, maxBatteryDrain: 20, updatedAt: null },
  });
});

router.put('/uar/relay', requireAuth, (req, res) => {
  const enabled = req.body.enabled === true;
  const allowCellular = req.body.allowCellular === true;
  const maxBatteryDrain = clampInt(req.body.maxBatteryDrain, 5, 60, 20);
  db.prepare(
    `INSERT INTO relay_consents (user_id, enabled, allow_cellular, max_battery_drain, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, allow_cellular = excluded.allow_cellular,
       max_battery_drain = excluded.max_battery_drain, updated_at = excluded.updated_at`
  ).run(req.user.id, enabled ? 1 : 0, allowCellular ? 1 : 0, maxBatteryDrain, now());
  audit(req.user.id, enabled ? 'relay.enable' : 'relay.disable', 'user', req.user.id, { allowCellular, maxBatteryDrain }, clientIp(req));
  res.json({ ok: true, relay: { enabled, allowCellular, maxBatteryDrain } });
});

export default router;
