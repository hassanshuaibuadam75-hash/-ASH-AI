// #ash Mesh — administration, moderation, audit and the exclusive Founder Dashboard.
import express from 'express';
import { db, now, parseJSON, toPublicUser, audit, notify } from '../db.js';
import { requireAuth, requireFounder, rateLimit, clean, clampInt, badRequest, clientIp } from '../lib.js';

const router = express.Router();

export const PERMISSIONS = [
  { key: 'users.view', label: 'View user directory' },
  { key: 'moderation.content', label: 'Remove posts and comments' },
  { key: 'moderation.users', label: 'Restrict or suspend accounts' },
  { key: 'moderation.reports', label: 'Review user reports' },
  { key: 'verification.review', label: 'Review seller verification' },
  { key: 'marketplace.view', label: 'View marketplace orders' },
  { key: 'marketplace.manage', label: 'Manage marketplace orders and refunds' },
  { key: 'audit.view', label: 'Read audit logs' },
];

const KNOWN = new Set(PERMISSIONS.map((p) => p.key));

function anyPermission(...keys) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
    if (req.user.is_founder === 1) return next();
    const granted = parseJSON(req.user.permissions, []);
    if (granted.includes('*') || keys.some((k) => granted.includes(k))) return next();
    return res.status(403).json({ error: 'permission_denied', message: 'You do not have permission for this action.' });
  };
}

function isAdminActor(req) {
  return req.user?.is_founder === 1 || ['admin', 'moderator'].includes(req.user?.role);
}

const count = (sql, ...params) => db.prepare(sql).get(...params)?.n || 0;
const since = (ms) => new Date(Date.now() - ms).toISOString();

/* --------------------------------- admin --------------------------------- */

router.get('/admin/overview', requireAuth, anyPermission('users.view', 'moderation.reports', 'verification.review', 'marketplace.view'), (req, res) => {
  const granted = req.user.is_founder === 1 ? PERMISSIONS.map((p) => p.key) : parseJSON(req.user.permissions, []);
  const can = (key) => req.user.is_founder === 1 || granted.includes('*') || granted.includes(key);
  const overview = { role: req.user.role, isFounder: req.user.is_founder === 1, permissions: granted };

  if (can('users.view')) {
    overview.users = {
      total: count('SELECT COUNT(*) AS n FROM users'),
      activeToday: count('SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?', since(86400000)),
      restricted: count("SELECT COUNT(*) AS n FROM users WHERE status = 'restricted'"),
      suspended: count("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'"),
    };
  }
  if (can('moderation.reports')) {
    overview.reports = {
      open: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      reviewing: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'reviewing'"),
      resolved: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'resolved'"),
    };
  }
  if (can('verification.review')) {
    overview.verifications = { pending: count("SELECT COUNT(*) AS n FROM seller_verifications WHERE status = 'pending'") };
  }
  if (can('marketplace.view')) {
    overview.marketplace = {
      activeListings: count("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status = 'active'"),
      orders: count('SELECT COUNT(*) AS n FROM orders'),
      paidOrders: count("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','shipped','completed')"),
      commissionMinor: count("SELECT COALESCE(SUM(commission_minor),0) AS n FROM orders WHERE status IN ('paid','shipped','completed')"),
    };
  }
  res.json({ overview, availablePermissions: PERMISSIONS });
});

router.get('/admin/users', requireAuth, anyPermission('users.view', 'moderation.users'), (req, res) => {
  const q = clean(req.query.q, 80);
  const status = clean(req.query.status, 20);
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const where = [];
  const params = [];
  if (q) { where.push('(username LIKE ? OR full_name LIKE ? OR email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (['active', 'restricted', 'suspended'].includes(status)) { where.push('status = ?'); params.push(status); }
  const rows = db.prepare(
    `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit);
  res.json({
    users: rows.map((r) => ({
      ...toPublicUser(r, req.user.id),
      email: r.email,
      status: r.status,
      role: r.role,
      permissions: parseJSON(r.permissions, []),
      isFounder: r.is_founder === 1,
    })),
  });
});

router.post('/admin/users/:id/status', requireAuth, anyPermission('moderation.users'), (req, res) => {
  const status = clean(req.body.status, 20);
  const reason = clean(req.body.reason, 300);
  if (!['active', 'restricted', 'suspended'].includes(status)) return badRequest(res, 'Unknown account status.');
  if (!reason) return badRequest(res, 'Record a reason for this account action.');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  if (target.is_founder === 1) return res.status(403).json({ error: 'founder_protected', message: 'Founder authority cannot be restricted.' });
  if (['admin', 'moderator'].includes(target.role) && req.user.is_founder !== 1) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the Founder can act on administrators.' });
  }
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
  if (status !== 'active') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  audit(req.user.id, `admin.user_${status}`, 'user', target.id, { reason }, clientIp(req));
  notify(target.id, { type: 'account_status', actorId: req.user.id, entityType: 'user', entityId: target.id, data: { status, reason } });
  res.json({ ok: true, user: { id: target.id, status } });
});

// Founder-only: grant or revoke limited administrative permissions.
router.post('/admin/users/:id/role', requireAuth, requireFounder, (req, res) => {
  const role = clean(req.body.role, 20);
  if (!['member', 'moderator', 'admin'].includes(role)) return badRequest(res, 'Unknown role.');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'User not found.' });
  if (target.is_founder === 1) return res.status(403).json({ error: 'founder_protected', message: 'Founder authority cannot be reassigned.' });
  const requested = Array.isArray(req.body.permissions) ? req.body.permissions : [];
  const invalid = requested.filter((p) => !KNOWN.has(p) && p !== '*');
  if (invalid.length) return badRequest(res, `Unknown permissions: ${invalid.join(', ')}`);
  const permissions = role === 'member' ? [] : requested.filter((p) => KNOWN.has(p) || p === '*');
  db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(role, JSON.stringify(permissions), target.id);
  audit(req.user.id, 'admin.role_change', 'user', target.id, { role, permissions }, clientIp(req));
  notify(target.id, { type: 'role_changed', actorId: req.user.id, entityType: 'user', entityId: target.id, data: { role, permissions } });
  res.json({ ok: true, user: { id: target.id, role, permissions } });
});

router.get('/admin/reports', requireAuth, anyPermission('moderation.reports', 'moderation.content'), (req, res) => {
  const status = clean(req.query.status, 20) || 'open';
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const rows = db.prepare(
    `SELECT r.*, u.username AS reporter_username FROM reports r JOIN users u ON u.id = r.reporter_id
     ${['open', 'reviewing', 'resolved', 'dismissed'].includes(status) ? 'WHERE r.status = ?' : ''}
     ORDER BY r.created_at DESC LIMIT ?`
  ).all(...( ['open', 'reviewing', 'resolved', 'dismissed'].includes(status) ? [status, limit] : [limit]));
  res.json({
    reports: rows.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.created_at,
      reporter: { id: r.reporter_id, username: r.reporter_username },
      resolutionNote: r.resolution_note,
    })),
  });
});

router.post('/admin/reports/:id/resolve', requireAuth, anyPermission('moderation.reports'), (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'not_found', message: 'Report not found.' });
  const action = clean(req.body.action, 30) || 'resolve';
  const note = clean(req.body.note, 500);
  const status = ['resolved', 'dismissed', 'reviewing'].includes(req.body.status) ? req.body.status : 'resolved';
  if (!note) return badRequest(res, 'Record a resolution note for the audit trail.');

  let acted = null;
  if (action === 'remove_content') {
    if (report.target_type === 'post') {
      db.prepare('UPDATE posts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), report.target_id);
      acted = 'post_removed';
    } else if (report.target_type === 'comment') {
      db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now(), report.target_id);
      acted = 'comment_removed';
    } else if (report.target_type === 'listing') {
      db.prepare("UPDATE marketplace_listings SET status = 'removed', updated_at = ? WHERE id = ?").run(now(), report.target_id);
      acted = 'listing_removed';
    }
  } else if (action === 'suspend_user' || action === 'restrict_user') {
    let userId = report.target_id;
    if (report.target_type === 'post') userId = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(report.target_id)?.author_id;
    if (report.target_type === 'comment') userId = db.prepare('SELECT author_id FROM comments WHERE id = ?').get(report.target_id)?.author_id;
    if (report.target_type === 'listing') userId = db.prepare('SELECT seller_id FROM marketplace_listings WHERE id = ?').get(report.target_id)?.seller_id;
    if (userId) {
      const target = db.prepare('SELECT is_founder FROM users WHERE id = ?').get(userId);
      if (target?.is_founder === 1) return res.status(403).json({ error: 'founder_protected', message: 'Founder authority cannot be restricted.' });
      const nextStatus = action === 'suspend_user' ? 'suspended' : 'restricted';
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, userId);
      if (nextStatus === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      acted = `${action}:${userId}`;
    }
  }

  db.prepare('UPDATE reports SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ?')
    .run(status, req.user.id, note, now(), report.id);
  audit(req.user.id, `moderation.report_${status}`, report.target_type, report.target_id, { action, note }, clientIp(req));
  res.json({ ok: true, status, action: acted });
});

router.get('/admin/verifications', requireAuth, anyPermission('verification.review'), (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(
    `SELECT v.*, u.username, u.full_name, u.is_verified_seller FROM seller_verifications v
     JOIN users u ON u.id = v.user_id WHERE v.status = ? ORDER BY v.created_at ASC LIMIT 100`
  ).all(status);
  res.json({
    verifications: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      fullName: r.full_name,
      businessName: r.business_name,
      idType: r.id_type,
      idNumber: r.id_number,
      documentUrl: r.doc_media_id ? `/api/media/${r.doc_media_id}` : null,
      status: r.status,
      createdAt: r.created_at,
      reviewNote: r.review_note,
    })),
  });
});

router.post('/admin/verifications/:id/review', requireAuth, anyPermission('verification.review'), (req, res) => {
  const row = db.prepare('SELECT * FROM seller_verifications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Verification not found.' });
  const decision = clean(req.body.decision, 20);
  const note = clean(req.body.note, 400);
  if (!['approve', 'reject'].includes(decision)) return badRequest(res, 'Decision must be approve or reject.');
  if (row.status !== 'pending') return badRequest(res, 'This verification has already been reviewed.');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE seller_verifications SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?')
    .run(status, req.user.id, note, now(), row.id);
  if (decision === 'approve') db.prepare('UPDATE users SET is_verified_seller = 1 WHERE id = ?').run(row.user_id);
  audit(req.user.id, `verification.${status}`, 'verification', row.id, { note }, clientIp(req));
  notify(row.user_id, { type: `seller_verification_${status}`, actorId: req.user.id, entityType: 'verification', entityId: row.id, data: { note } });
  res.json({ ok: true, status });
});

router.get('/admin/audit', requireAuth, anyPermission('audit.view'), (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 100);
  const rows = db.prepare(
    `SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT ?`
  ).all(limit);
  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor_id ? { id: r.actor_id, username: r.username } : null,
      targetType: r.target_type,
      targetId: r.target_id,
      meta: parseJSON(r.meta, {}),
      ip: r.ip,
      createdAt: r.created_at,
    })),
  });
});

/* --------------------- exclusive Founder Dashboard ---------------------- */

router.get('/founder/dashboard', requireAuth, requireFounder, rateLimit({ name: 'founder', limit: 120, windowMs: 60 * 1000 }), (req, res) => {
  const dayAgo = since(86400000);
  const weekAgo = since(7 * 86400000);

  const people = {
    totalUsers: count('SELECT COUNT(*) AS n FROM users'),
    active24h: count('SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?', dayAgo),
    newToday: count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', dayAgo),
    newThisWeek: count('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', weekAgo),
    restricted: count("SELECT COUNT(*) AS n FROM users WHERE status = 'restricted'"),
    suspended: count("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'"),
    verifiedSellers: count('SELECT COUNT(*) AS n FROM users WHERE is_verified_seller = 1'),
    admins: count("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','moderator')"),
  };

  const content = {
    posts: count('SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL'),
    comments: count('SELECT COUNT(*) AS n FROM comments WHERE deleted_at IS NULL'),
    likes: count('SELECT COUNT(*) AS n FROM post_likes'),
    posts24h: count('SELECT COUNT(*) AS n FROM posts WHERE created_at >= ? AND deleted_at IS NULL', dayAgo),
    models3d: count("SELECT COUNT(*) AS n FROM posts WHERE kind = 'model' AND deleted_at IS NULL"),
  };

  const messaging = {
    conversations: count('SELECT COUNT(*) AS n FROM conversations'),
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    messages24h: count('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', dayAgo),
    viaInternet: count("SELECT COUNT(*) AS n FROM messages WHERE transport = 'internet'"),
    viaNearby: count("SELECT COUNT(*) AS n FROM messages WHERE transport = 'nearby'"),
    queued: count("SELECT COUNT(*) AS n FROM messages WHERE transport = 'queued'"),
    encryption: 'Client-side AES-256-GCM; the server stores ciphertext envelopes only.',
  };

  const marketplace = {
    activeListings: count("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status = 'active'"),
    soldListings: count("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status = 'sold'"),
    orders: count('SELECT COUNT(*) AS n FROM orders'),
    paidOrders: count("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','shipped','completed')"),
    gmvMinor: count("SELECT COALESCE(SUM(amount_minor),0) AS n FROM orders WHERE status IN ('paid','shipped','completed')"),
    commissionMinor: count("SELECT COALESCE(SUM(commission_minor),0) AS n FROM orders WHERE status IN ('paid','shipped','completed')"),
    transactions: count('SELECT COUNT(*) AS n FROM transactions'),
    pendingVerifications: count("SELECT COUNT(*) AS n FROM seller_verifications WHERE status = 'pending'"),
  };

  const moderation = {
    openReports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    reviewingReports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'reviewing'"),
    resolvedReports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'resolved'"),
    dismissedReports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'dismissed'"),
  };

  const networking = db.prepare(
    `SELECT transport, COUNT(*) AS total, MAX(created_at) AS last_at,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24h
     FROM uar_telemetry GROUP BY transport ORDER BY total DESC`
  ).all(dayAgo);
  const networkingMap = Object.fromEntries(networking.map((r) => [r.transport, { total: r.total, last24h: r.last24h, lastAt: r.last_at }]));
  const relays = db.prepare('SELECT COUNT(*) AS n FROM relay_consents WHERE enabled = 1').get().n;

  const dbBytes = (() => {
    try {
      const info = db.prepare('PRAGMA page_count').get();
      const size = db.prepare('PRAGMA page_size').get();
      return (info.page_count || 0) * (size.page_size || 0);
    } catch { return 0; }
  })();
  const memory = process.memoryUsage();

  const recentAudit = db.prepare(
    `SELECT a.action, a.target_type, a.target_id, a.created_at, u.username
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 12`
  ).all();

  const aiCalls = {
    last24h: count('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?', dayAgo),
    last7d: count('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?', weekAgo),
    configured: !!process.env.GROQ_API_KEY,
  };

  res.json({
    founder: { name: 'Hassan Shuaibu Adam', title: 'Founder & CEO' },
    generatedAt: now(),
    people,
    content,
    messaging,
    marketplace,
    moderation,
    networking: {
      transports: networkingMap,
      relayDevices: relays,
      internetConnectivity: {
        activeSessions: count('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', now()),
        lastInternetTelemetry: networkingMap.internet?.lastAt || null,
        lastNearbyTelemetry: networkingMap.nearby?.lastAt || networkingMap.wifi_aware?.lastAt || null,
      },
    },
    system: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(memory.rss / 1024 / 1024),
      dbSizeMb: Math.round((dbBytes / 1024 / 1024) * 10) / 10,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      storageBackend: process.env.SUPABASE_URL ? 'Supabase (configured)' : 'Local SQLite + disk',
      paymentsConfigured: !!process.env.PAYSTACK_SECRET_KEY,
      aiConfigured: !!process.env.GROQ_API_KEY,
      emailConfigured: !!process.env.RESEND_API_KEY,
    },
    recentAudit: recentAudit.map((r) => ({ ...r, action: r.action })),
  });
});

export default router;
