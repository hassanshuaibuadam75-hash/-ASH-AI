// #ash Mesh — content moderation core.
//
// Safety rules this module enforces:
//   * Nothing is deleted or banned automatically. A high-confidence finding only
//     QUARANTINES content (hidden from other people, still visible to its author with a
//     notice) until an authorised human decides.
//   * The original text is stored as evidence with every finding, so a decision can
//     always be reviewed or appealed.
//   * Classification runs locally and deterministically, so it works offline and cannot
//     fail because a provider is unavailable. Staff can request the AI second opinion on
//     any stored finding through the existing /api/ai/moderate/check analysis.
import { db, uid, now, notify, audit } from './db.js';

// Confidence bands. Below `review` nothing is recorded; between review and quarantine the
// content stays visible but enters the human queue; at or above quarantine it is hidden
// from everyone except its author and staff until a person decides.
export const THRESHOLDS = { review: 0.5, quarantine: 0.85 };

export const CATEGORY_LABELS = {
  sexual: 'Explicit sexual content',
  gambling: 'Gambling promotion',
  hate: 'Hate speech',
  harassment: 'Harassment or abuse',
  counterfeit: 'Counterfeit goods',
  misleading_price: 'Misleading price or deceptive advert',
  scam: 'Scam or fraud',
  spam: 'Spam',
};

// Weighted signals. Each match adds its weight; a single severe signal is enough on its
// own to reach quarantine. Patterns are specific so ordinary conversation stays clear.
const RULES = [
  // --- explicit sexual content ---
  {
    category: 'sexual',
    re: /\b(porn|pornography|pornographic|xxx|nsfw|nudes?|sexting|onlyfans|escort\s+service)\b/i,
    weight: 0.9,
    reason: 'Explicit sexual content',
  },
  {
    category: 'sexual',
    re: /\b(sex\s+videos?|sex\s+clips?|sexual\s+videos?)\b/i,
    weight: 0.9,
    reason: 'Explicit sexual content',
  },

  // --- gambling ---
  {
    category: 'gambling',
    re: /\b(betting\s+(site|tips|platform)|bet9ja|sportybet|1xbet|betway|casino|jackpot|stake\.com|aviator\s+game|sure\s+odds)\b/i,
    weight: 0.6,
    reason: 'Gambling promotion',
  },
  {
    category: 'gambling',
    re: /\b(win|make)\b.{0,25}\b(daily|guaranteed)\b.{0,25}\b(betting|odds|stake)\b/i,
    weight: 0.5,
    reason: 'Promotes betting returns',
  },

  // --- hate speech ---
  {
    category: 'hate',
    re: /\b(kill\s+all|exterminate|sub-?human|vermin|inferior\s+race|ethnic\s+cleansing)\b/i,
    weight: 0.95,
    reason: 'Dehumanising or violent hate speech',
  },
  {
    category: 'hate',
    re: /\b(terrorist\s+lovers?|jihadist\s+scum|infidel\s+dogs?)\b/i,
    weight: 0.9,
    reason: 'Hate slur',
  },

  // --- harassment ---
  {
    category: 'harassment',
    re: /\b(i\s+will\s+(kill|hurt|beat|find)\s+you|you\s+(will|should)\s+die|go\s+kill\s+yourself|kys)\b/i,
    weight: 0.95,
    reason: 'Threat or targeted abuse',
  },
  {
    category: 'harassment',
    re: /\b(stupid|ugly|worthless)\s+(idiot|fool|animal|pig)\b/i,
    weight: 0.55,
    reason: 'Targeted insult',
  },

  // --- counterfeit ---
  {
    category: 'counterfeit',
    re: /\b(replica|fake|copy|knock[- ]?off|first\s+copy|mirror\s+quality)\b.{0,30}\b(iphone|samsung|gucci|nike|adidas|rolex|louis\s+vuitton|jordan|bag|watch|phone)\b/i,
    weight: 0.7,
    reason: 'Offers counterfeit branded goods',
  },
  {
    category: 'counterfeit',
    re: /\b(original\s+copy|same\s+as\s+original)\b/i,
    weight: 0.5,
    reason: 'Implies counterfeit goods',
  },

  // --- misleading price / deceptive advert ---
  {
    category: 'misleading_price',
    re: /₦\s?0(\.00)?\b|\bprice\s*[:=]\s*0\b/i,
    weight: 0.55,
    reason: 'Impossible price used as bait',
  },
  {
    category: 'misleading_price',
    re: /\b(price\s+on\s+dm|dm\s+for\s+price)\b.{0,40}\b(cheap|cheapest|giveaway)\b/i,
    weight: 0.45,
    reason: 'Vague bait pricing',
  },
  {
    category: 'misleading_price',
    re: /\b\d{1,3}%\s*(off|discount)\b.{0,25}\b(today\s+only|last\s+chance)\b/i,
    weight: 0.3,
    reason: 'Pressure-sale advert',
  },

  // --- scams ---
  {
    category: 'scam',
    re: /\b(bank\s+details|account\s+number|card\s+number|cvv|otp\b|one[- ]?time\s+password|bvn\b|seed\s+phrase|private\s+key)\b/i,
    weight: 0.9,
    reason: 'Asks for sensitive financial or account details',
  },
  {
    category: 'scam',
    re: /\b(guaranteed|double)\s+(profit|returns?|your\s+money)\b/i,
    weight: 0.75,
    reason: 'Promises guaranteed financial returns',
  },
  {
    category: 'scam',
    re: /\b(send|pay|transfer)\s+(me\s+)?(money|cash|btc|usdt)\b/i,
    weight: 0.7,
    reason: 'Requests direct payment',
  },
  {
    category: 'scam',
    re: /\b(you\s+have\s+won|claim\s+your\s+(prize|reward)|lottery\s+winner)\b/i,
    weight: 0.6,
    reason: 'Prize or lottery claim',
  },

  // --- spam ---
  {
    category: 'spam',
    re: /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|is\.gd)\b/i,
    weight: 0.45,
    reason: 'Link shortener typical of spam',
  },
  {
    category: 'spam',
    re: /(.)\1{7,}/,
    weight: 0.35,
    reason: 'Repeated character padding',
  },
];

/**
 * Deterministic local classification. Returns a 0..1 confidence score, the matched
 * categories and human-readable reasons. Pure function: no database, no network.
 */
export function classify(text) {
  const value = String(text || '');
  const reasons = [];
  const categories = new Set();
  let score = 0;

  for (const rule of RULES) {
    if (!rule.re.test(value)) continue;
    score += rule.weight;
    categories.add(rule.category);
    if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
  }

  score = Math.min(1, Number(score.toFixed(2)));
  return { score, categories: [...categories], reasons, source: 'rules' };
}

export function bandFor(score) {
  if (score >= THRESHOLDS.quarantine) return 'quarantine';
  if (score >= THRESHOLDS.review) return 'review';
  return 'clear';
}

export function ensureModerationSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS moderation_reviews (
      id               TEXT PRIMARY KEY,
      target_type      TEXT NOT NULL,
      target_id        TEXT NOT NULL,
      author_id        TEXT NOT NULL,
      category         TEXT NOT NULL DEFAULT 'spam',
      score            REAL NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'review',
      reasons          TEXT NOT NULL DEFAULT '[]',
      evidence         TEXT NOT NULL DEFAULT '{}',
      content_snapshot TEXT NOT NULL DEFAULT '',
      source           TEXT NOT NULL DEFAULT 'rules',
      reviewer_id      TEXT,
      decision_note    TEXT NOT NULL DEFAULT '',
      decided_at       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mod_reviews_status ON moderation_reviews (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mod_reviews_author ON moderation_reviews (author_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS moderation_appeals (
      id            TEXT PRIMARY KEY,
      review_id     TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      message       TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'open',
      decided_by    TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      decided_at    TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mod_appeals_status ON moderation_appeals (status, created_at DESC);
  `);

  // Additive column: keeps content state separate from deletion, so a moderation
  // decision never destroys a post.
  const cols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
  if (!cols.includes('moderation_status')) {
    try {
      db.exec("ALTER TABLE posts ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'visible'");
    } catch {
      /* already added by a concurrent boot */
    }
  }
}

ensureModerationSchema();

/**
 * Screen text that is about to become public. Records a review for anything at or above
 * the review band and quarantines content at or above the quarantine band. Never deletes
 * content, never changes an account's status.
 */
export function screenContent({ targetType, targetId, authorId, text }) {
  const result = classify(text);
  const status = bandFor(result.score);

  if (status === 'clear') {
    return { ...result, status, reviewId: null };
  }

  const id = uid('mod_');
  const category = result.categories[0] || 'spam';
  db.prepare(
    `INSERT INTO moderation_reviews
       (id, target_type, target_id, author_id, category, score, status, reasons, evidence, content_snapshot, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    targetType,
    targetId,
    authorId,
    category,
    result.score,
    status,
    JSON.stringify(result.reasons),
    JSON.stringify({ categories: result.categories, reasons: result.reasons, thresholds: THRESHOLDS }),
    String(text || '').slice(0, 4000),
    'rules',
    now(),
    now()
  );

  if (status === 'quarantine' && targetType === 'post') {
    db.prepare('UPDATE posts SET moderation_status = ? WHERE id = ?').run('quarantined', targetId);
  }

  // Tell the author, without disclosing staff tools or another user's report.
  try {
    notify(authorId, {
      type: 'moderation_review',
      entityType: targetType,
      entityId: targetId,
      data: {
        status,
        category: CATEGORY_LABELS[category] || category,
        message:
          status === 'quarantine'
            ? 'Your content is hidden from others while a moderator reviews it. You can appeal.'
            : 'Your content is visible but a moderator will review it. You can appeal.',
      },
    });
  } catch {
    /* notifications are best-effort; the review record is the source of truth */
  }

  return { ...result, status, reviewId: id };
}

export function reviewView(row) {
  if (!row) return null;
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    authorId: row.author_id,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    score: row.score,
    status: row.status,
    reasons: safeJson(row.reasons, []),
    evidence: safeJson(row.evidence, {}),
    contentSnapshot: row.content_snapshot,
    source: row.source,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** A human decision. `approve` restores the content; `remove` hides it. Neither deletes. */
export function decideReview({ reviewId, staffId, action, note }) {
  const review = db.prepare('SELECT * FROM moderation_reviews WHERE id = ?').get(reviewId);
  if (!review) return { error: 'not_found' };
  if (!['approve', 'remove'].includes(action)) return { error: 'invalid_action' };

  const status = action === 'approve' ? 'approved' : 'removed';
  db.prepare(
    'UPDATE moderation_reviews SET status = ?, reviewer_id = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?'
  ).run(status, staffId, String(note || '').slice(0, 500), now(), now(), reviewId);

  if (review.target_type === 'post') {
    db.prepare('UPDATE posts SET moderation_status = ? WHERE id = ?').run(
      action === 'approve' ? 'visible' : 'removed',
      review.target_id
    );
  }

  try {
    audit(staffId, `moderation.${action}`, review.target_type, review.target_id, { reviewId, score: review.score }, null);
  } catch {
    /* audit is best-effort */
  }

  // Close any open appeal with the same decision, so the author gets an answer.
  db.prepare(
    "UPDATE moderation_appeals SET status = ?, decided_by = ?, decided_at = ? WHERE review_id = ? AND status = 'open'"
  ).run(action === 'approve' ? 'accepted' : 'rejected', staffId, now(), reviewId);

  return { review: reviewView(db.prepare('SELECT * FROM moderation_reviews WHERE id = ?').get(reviewId)) };
}

export function createAppeal({ reviewId, userId, message }) {
  const review = db.prepare('SELECT * FROM moderation_reviews WHERE id = ?').get(reviewId);
  if (!review) return { error: 'not_found' };
  if (review.author_id !== userId) return { error: 'forbidden' };
  if (review.status === 'approved') return { error: 'not_applicable' };

  const open = db.prepare("SELECT * FROM moderation_appeals WHERE review_id = ? AND status = 'open'").get(reviewId);
  if (open) return { appeal: appealView(open), duplicate: true };

  const id = uid('apl_');
  db.prepare(
    'INSERT INTO moderation_appeals (id, review_id, user_id, message, status, created_at) VALUES (?,?,?,?,?,?)'
  ).run(id, reviewId, userId, String(message || '').slice(0, 2000), 'open', now());

  return { appeal: appealView(db.prepare('SELECT * FROM moderation_appeals WHERE id = ?').get(id)) };
}

export function decideAppeal({ appealId, staffId, action, note }) {
  const appeal = db.prepare('SELECT * FROM moderation_appeals WHERE id = ?').get(appealId);
  if (!appeal) return { error: 'not_found' };
  if (!['accept', 'reject'].includes(action)) return { error: 'invalid_action' };
  if (appeal.status !== 'open') return { error: 'already_decided' };

  const status = action === 'accept' ? 'accepted' : 'rejected';
  db.prepare('UPDATE moderation_appeals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?')
    .run(status, staffId, String(note || '').slice(0, 500), now(), appealId);

  if (action === 'accept') {
    db.prepare("UPDATE moderation_reviews SET status = 'approved', reviewer_id = ?, decided_at = ?, updated_at = ? WHERE id = ?")
      .run(staffId, now(), now(), appeal.review_id);
    const review = db.prepare('SELECT * FROM moderation_reviews WHERE id = ?').get(appeal.review_id);
    if (review?.target_type === 'post') {
      db.prepare("UPDATE posts SET moderation_status = 'visible' WHERE id = ?").run(review.target_id);
    }
  }

  return { appeal: appealView(db.prepare('SELECT * FROM moderation_appeals WHERE id = ?').get(appealId)) };
}

export function appealView(row) {
  if (!row) return null;
  return {
    id: row.id,
    reviewId: row.review_id,
    userId: row.user_id,
    message: row.message,
    status: row.status,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export function moderationStats() {
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;
  return {
    queue: count("SELECT COUNT(*) c FROM moderation_reviews WHERE status IN ('review','quarantine')"),
    quarantined: count("SELECT COUNT(*) c FROM moderation_reviews WHERE status = 'quarantine'"),
    awaitingHuman: count("SELECT COUNT(*) c FROM moderation_reviews WHERE status = 'review'"),
    removed: count("SELECT COUNT(*) c FROM moderation_reviews WHERE status = 'removed'"),
    approved: count("SELECT COUNT(*) c FROM moderation_reviews WHERE status = 'approved'"),
    openAppeals: count("SELECT COUNT(*) c FROM moderation_appeals WHERE status = 'open'"),
    total: count('SELECT COUNT(*) c FROM moderation_reviews'),
    thresholds: THRESHOLDS,
  };
}
