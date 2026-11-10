// #ash Mesh — moderation review queue and appeals API.
//
// Human decisions only: this router can hide or restore content, but it never deletes a
// post, never bans an account and never changes a role. Founder-level authority stays with
// the Founder account; staff here need moderation permission.
import express from 'express';
import { db, now, parseJSON } from './db.js';
import { requireAuth, rateLimit, clean, badRequest } from './lib.js';
import {
  THRESHOLDS,
  reviewView,
  appealView,
  decideReview,
  createAppeal,
  decideAppeal,
  moderationStats,
  classify,
} from './moderation.js';

const router = express.Router();

export function isModerationStaff(user) {
  if (!user) return false;
  if (user.is_founder === 1 || user.role === 'founder') return true;
  if (user.role === 'admin' || user.role === 'moderator') return true;
  return parseJSON(user.permissions, []).includes('moderation.content');
}

function requireModerationStaff(req, res, next) {
  if (!isModerationStaff(req.user)) {
    return res.status(403).json({ error: 'forbidden', message: 'Moderation permission required.' });
  }
  return next();
}

/* --------------------------------- queue ---------------------------------- */

router.get('/moderation/queue', requireAuth, requireModerationStaff, (req, res) => {
  const status = clean(req.query.status, 20) || 'open';
  const limit = 50;
  const rows =
    status === 'open'
      ? db
          .prepare(
            "SELECT * FROM moderation_reviews WHERE status IN ('review','quarantine') ORDER BY score DESC, created_at DESC LIMIT ?"
          )
          .all(limit)
      : db.prepare('SELECT * FROM moderation_reviews WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);

  res.json({
    reviews: rows.map(reviewView),
    thresholds: THRESHOLDS,
    stats: moderationStats(),
  });
});

router.get('/moderation/stats', requireAuth, requireModerationStaff, (_req, res) => {
  res.json({ stats: moderationStats(), thresholds: THRESHOLDS });
});

router.get('/moderation/reviews/:id', requireAuth, requireModerationStaff, (req, res) => {
  const row = db.prepare('SELECT * FROM moderation_reviews WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Review not found.' });
  const appeals = db
    .prepare('SELECT * FROM moderation_appeals WHERE review_id = ? ORDER BY created_at DESC')
    .all(row.id)
    .map(appealView);
  res.json({ review: reviewView(row), appeals });
});

router.post(
  '/moderation/reviews/:id/decide',
  requireAuth,
  requireModerationStaff,
  rateLimit({ name: 'mod_decide', limit: 200, windowMs: 60 * 60 * 1000 }),
  (req, res) => {
    const action = clean(req.body.action, 20);
    if (!['approve', 'remove'].includes(action)) {
      return badRequest(res, 'Choose "approve" to restore the content or "remove" to hide it.');
    }
    const result = decideReview({
      reviewId: req.params.id,
      staffId: req.user.id,
      action,
      note: clean(req.body.note, 500),
    });
    if (result.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Review not found.' });
    if (result.error) return badRequest(res, 'That decision is not supported.');
    return res.json({ review: result.review, stats: moderationStats() });
  }
);

/* -------------------------------- appeals --------------------------------- */

router.post(
  '/moderation/reviews/:id/appeal',
  requireAuth,
  rateLimit({ name: 'mod_appeal', limit: 20, windowMs: 24 * 60 * 60 * 1000 }),
  (req, res) => {
    const message = clean(req.body.message, 2000);
    const result = createAppeal({ reviewId: req.params.id, userId: req.user.id, message });
    if (result.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Review not found.' });
    if (result.error === 'forbidden') {
      return res.status(403).json({ error: 'forbidden', message: 'You can only appeal your own content.' });
    }
    if (result.error === 'not_applicable') {
      return res.status(409).json({ error: 'not_applicable', message: 'This content is already approved.' });
    }
    return res.status(result.duplicate ? 200 : 201).json({ appeal: result.appeal, duplicate: !!result.duplicate });
  }
);

router.get('/moderation/appeals', requireAuth, requireModerationStaff, (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM moderation_appeals WHERE status = 'open' ORDER BY created_at ASC LIMIT 50")
    .all()
    .map(appealView);
  res.json({ appeals: rows });
});

router.post(
  '/moderation/appeals/:id/decide',
  requireAuth,
  requireModerationStaff,
  rateLimit({ name: 'mod_appeal_decide', limit: 200, windowMs: 60 * 60 * 1000 }),
  (req, res) => {
    const action = clean(req.body.action, 20);
    if (!['accept', 'reject'].includes(action)) {
      return badRequest(res, 'Choose "accept" or "reject".');
    }
    const result = decideAppeal({
      appealId: req.params.id,
      staffId: req.user.id,
      action,
      note: clean(req.body.note, 500),
    });
    if (result.error === 'not_found') return res.status(404).json({ error: 'not_found', message: 'Appeal not found.' });
    if (result.error === 'already_decided') {
      return res.status(409).json({ error: 'already_decided', message: 'This appeal has already been decided.' });
    }
    if (result.error) return badRequest(res, 'That decision is not supported.');
    return res.json({ appeal: result.appeal });
  }
);

/* ----------------------------- author notices ----------------------------- */

// What the author of the content can see about their own moderation state, including the
// ability to appeal. Deliberately excludes who reviewed it and any staff-only tooling.
router.get('/moderation/mine', requireAuth, (req, res) => {
  const reviews = db
    .prepare('SELECT * FROM moderation_reviews WHERE author_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(req.user.id)
    .map(reviewView);
  const appeals = db
    .prepare('SELECT * FROM moderation_appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(req.user.id)
    .map(appealView);
  res.json({ reviews, appeals, thresholds: THRESHOLDS });
});

// Local rules preview. Works offline and never needs the AI provider; staff use it to see
// exactly what the deterministic classifier thinks before recording a finding.
router.post('/moderation/preview', requireAuth, requireModerationStaff, (req, res) => {
  const text = clean(req.body.text, 4000);
  if (!text) return badRequest(res, 'Provide the text to check.');
  res.json({ result: classify(text), thresholds: THRESHOLDS, checkedAt: now() });
});

export default router;
