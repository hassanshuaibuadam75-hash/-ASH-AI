// #ash Mesh — #ash Heritage: community-recorded culture, language and history.
//
// Members publish heritage entries (stories, languages, crafts, music, history,
// recipes) tagged by region and language. Entries are publicly readable so they can
// be cached and read offline; writing, editing and deleting require ownership.
import express from 'express';
import { db, uid, now, toPublicUser, isFounder, audit } from './db.js';
import { requireAuth, upload, saveMedia, rateLimit, clean, badRequest } from './lib.js';

const router = express.Router();

const CATEGORIES = ['story', 'language', 'craft', 'music', 'history', 'recipe'];
const REACTIONS = ['respect', 'love', 'insightful'];

function canManage(user, row) {
  return !!user && (user.id === row.author_id || isFounder(user) || user.role === 'admin');
}

export function serializeHeritage(row, viewerId = null) {
  if (!row) return null;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  const reactions = db
    .prepare('SELECT kind, COUNT(*) c FROM heritage_reactions WHERE entry_id = ? GROUP BY kind')
    .all(row.id);
  const mine = viewerId
    ? db.prepare('SELECT kind FROM heritage_reactions WHERE entry_id = ? AND user_id = ?').all(row.id, viewerId).map((r) => r.kind)
    : [];

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    region: row.region,
    country: row.country,
    language: row.language,
    mediaUrl: row.media_id ? `/api/media/${row.media_id}` : null,
    published: !!row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: toPublicUser(author, viewerId),
    reactions: Object.fromEntries(reactions.map((r) => [r.kind, r.c])),
    myReactions: mine,
    isOwner: !!viewerId && viewerId === row.author_id,
  };
}

function loadEntry(id) {
  return db.prepare('SELECT * FROM heritage_entries WHERE id = ? AND deleted_at IS NULL').get(id);
}

router.get('/heritage', requireAuth, (req, res) => {
  const q = clean(req.query.q, 80);
  const category = clean(req.query.category, 40);
  const region = clean(req.query.region, 80);
  const mine = req.query.mine === '1';

  let sql = 'SELECT * FROM heritage_entries WHERE deleted_at IS NULL';
  const params = [];
  if (mine) {
    sql += ' AND author_id = ?';
    params.push(req.user.id);
  } else {
    sql += ' AND published = 1';
  }
  if (q) {
    sql += ' AND (title LIKE ? OR body LIKE ? OR region LIKE ? OR language LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (region) {
    sql += ' AND region = ?';
    params.push(region);
  }
  sql += ' ORDER BY updated_at DESC LIMIT 100';

  const entries = db.prepare(sql).all(...params).map((row) => serializeHeritage(row, req.user.id));
  res.json({ entries, categories: CATEGORIES });
});

router.post(
  '/heritage',
  requireAuth,
  rateLimit({ name: 'heritage_write', limit: 40, windowMs: 60 * 60 * 1000 }),
  upload.single('file'),
  (req, res) => {
    const title = clean(req.body.title, 160);
    const body = clean(req.body.body, 20000);
    if (title.length < 3) return badRequest(res, 'Give this entry a title of at least 3 characters.');
    if (!body) return badRequest(res, 'Write the story or knowledge you are preserving.');

    let mediaId = null;
    if (req.file) {
      try {
        mediaId = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'image' }).id;
      } catch (err) {
        return res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Upload failed.' });
      }
    }

    const id = uid('hrg_');
    const ts = now();
    db.prepare(
      `INSERT INTO heritage_entries (id, author_id, title, body, category, region, country, language, media_id, published, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      req.user.id,
      title,
      body,
      CATEGORIES.includes(req.body.category) ? req.body.category : 'story',
      clean(req.body.region, 80) || null,
      clean(req.body.country, 80) || null,
      clean(req.body.language, 40) || null,
      mediaId,
      req.body.published === '0' || req.body.published === 'false' ? 0 : 1,
      ts,
      ts,
    );

    audit(req.user.id, 'heritage.create', 'heritage_entry', id, { category: req.body.category });
    res.status(201).json({ entry: serializeHeritage(loadEntry(id), req.user.id) });
  },
);

router.get('/heritage/:id', requireAuth, (req, res) => {
  const row = loadEntry(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Entry not found.' });
  if (!row.published && !canManage(req.user, row)) {
    return res.status(403).json({ error: 'forbidden', message: 'This entry is not published.' });
  }
  res.json({ entry: serializeHeritage(row, req.user.id) });
});

router.patch('/heritage/:id', requireAuth, (req, res) => {
  const row = loadEntry(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Entry not found.' });
  if (!canManage(req.user, row)) return res.status(403).json({ error: 'forbidden', message: 'You cannot edit this entry.' });

  const title = req.body.title === undefined ? row.title : clean(req.body.title, 160);
  const body = req.body.body === undefined ? row.body : clean(req.body.body, 20000);
  if (title.length < 3 || !body) return badRequest(res, 'A title and body are required.');

  db.prepare(
    'UPDATE heritage_entries SET title = ?, body = ?, category = ?, region = ?, country = ?, language = ?, published = ?, updated_at = ? WHERE id = ?',
  ).run(
    title,
    body,
    CATEGORIES.includes(req.body.category) ? req.body.category : row.category,
    req.body.region === undefined ? row.region : clean(req.body.region, 80) || null,
    req.body.country === undefined ? row.country : clean(req.body.country, 80) || null,
    req.body.language === undefined ? row.language : clean(req.body.language, 40) || null,
    req.body.published === undefined ? row.published : (req.body.published ? 1 : 0),
    now(),
    row.id,
  );

  audit(req.user.id, 'heritage.update', 'heritage_entry', row.id, {});
  res.json({ entry: serializeHeritage(loadEntry(row.id), req.user.id) });
});

router.delete('/heritage/:id', requireAuth, (req, res) => {
  const row = loadEntry(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Entry not found.' });
  if (!canManage(req.user, row)) return res.status(403).json({ error: 'forbidden', message: 'You cannot delete this entry.' });
  if (req.query.confirm !== '1') {
    return res.status(428).json({ error: 'confirmation_required', message: 'Confirm deletion to remove this entry.' });
  }
  db.prepare('UPDATE heritage_entries SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), row.id);
  audit(req.user.id, 'heritage.delete', 'heritage_entry', row.id, {});
  res.json({ ok: true });
});

router.post('/heritage/:id/react', requireAuth, (req, res) => {
  const row = loadEntry(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Entry not found.' });
  if (!row.published && !canManage(req.user, row)) {
    return res.status(403).json({ error: 'forbidden', message: 'This entry is not published.' });
  }

  const kind = REACTIONS.includes(req.body.kind) ? req.body.kind : 'respect';
  const existing = db
    .prepare('SELECT 1 FROM heritage_reactions WHERE entry_id = ? AND user_id = ? AND kind = ?')
    .get(row.id, req.user.id, kind);

  if (existing) {
    db.prepare('DELETE FROM heritage_reactions WHERE entry_id = ? AND user_id = ? AND kind = ?').run(row.id, req.user.id, kind);
  } else {
    db.prepare('INSERT INTO heritage_reactions (entry_id, user_id, kind, created_at) VALUES (?,?,?,?)')
      .run(row.id, req.user.id, kind, now());
  }

  res.json({ entry: serializeHeritage(loadEntry(row.id), req.user.id) });
});

router.get('/heritage/offline-bundle', requireAuth, (req, res) => {
  const entries = db
    .prepare('SELECT * FROM heritage_entries WHERE deleted_at IS NULL AND published = 1 ORDER BY updated_at DESC LIMIT 100')
    .all()
    .map((row) => serializeHeritage(row, req.user.id));
  res.json({ entries, generatedAt: now() });
});

export default router;
