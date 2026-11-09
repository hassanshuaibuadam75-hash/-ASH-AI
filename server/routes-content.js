// #ash Mesh — #ash Academy: community learning content.
//
// Courses contain ordered lessons. Any authenticated member can publish a course;
// the author (or an administrator/Founder) can edit, unpublish or delete it.
// Learners enrol and mark lessons complete, which drives real progress records.
// Everything here is returned in a shape the client caches for offline reading.
import express from 'express';
import { db, uid, now, parseJSON, toPublicUser, isFounder, audit } from './db.js';
import { requireAuth, upload, saveMedia, rateLimit, clean, clampInt, badRequest } from './lib.js';

const router = express.Router();

const LEVELS = ['beginner', 'intermediate', 'advanced'];

function canManage(user, row) {
  return !!user && (user.id === row.author_id || isFounder(user) || user.role === 'admin');
}

function serializeLesson(row) {
  return {
    id: row.id,
    courseId: row.course_id,
    position: row.position,
    title: row.title,
    body: row.body,
    mediaUrl: row.media_id ? `/api/media/${row.media_id}` : null,
    durationMinutes: row.duration_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeCourse(row, viewerId = null) {
  if (!row) return null;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  const lessons = db
    .prepare('SELECT * FROM academy_lessons WHERE course_id = ? AND deleted_at IS NULL ORDER BY position, created_at')
    .all(row.id);
  const enrollment = viewerId
    ? db.prepare('SELECT * FROM academy_enrollments WHERE course_id = ? AND user_id = ?').get(row.id, viewerId)
    : null;

  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    language: row.language,
    level: row.level,
    coverUrl: row.cover_media_id ? `/api/media/${row.cover_media_id}` : null,
    published: !!row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: toPublicUser(author, viewerId),
    lessonCount: lessons.length,
    totalMinutes: lessons.reduce((total, lesson) => total + (lesson.duration_minutes || 0), 0),
    lessons: lessons.map(serializeLesson),
    enrolled: !!enrollment,
    progress: enrollment?.progress || 0,
    completedLessonIds: parseJSON(enrollment?.completed_lesson_ids, []),
    isOwner: !!viewerId && viewerId === row.author_id,
  };
}

function loadCourse(id) {
  return db.prepare('SELECT * FROM academy_courses WHERE id = ? AND deleted_at IS NULL').get(id);
}

/* --------------------------------- courses -------------------------------- */

router.get('/academy/courses', requireAuth, (req, res) => {
  const q = clean(req.query.q, 80);
  const category = clean(req.query.category, 40);
  const mine = req.query.mine === '1';

  let sql = 'SELECT * FROM academy_courses WHERE deleted_at IS NULL';
  const params = [];
  if (mine) {
    sql += ' AND author_id = ?';
    params.push(req.user.id);
  } else {
    sql += ' AND published = 1';
  }
  if (q) {
    sql += ' AND (title LIKE ? OR summary LIKE ? OR category LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY updated_at DESC LIMIT 100';

  const courses = db.prepare(sql).all(...params).map((row) => serializeCourse(row, req.user.id));
  res.json({ courses });
});

router.post(
  '/academy/courses',
  requireAuth,
  rateLimit({ name: 'academy_write', limit: 30, windowMs: 60 * 60 * 1000 }),
  upload.single('file'),
  (req, res) => {
    const title = clean(req.body.title, 160);
    if (title.length < 3) return badRequest(res, 'Give the course a title of at least 3 characters.');

    let coverMediaId = null;
    if (req.file) {
      try {
        coverMediaId = saveMedia({ file: req.file, ownerId: req.user.id, kind: 'image' }).id;
      } catch (err) {
        return res.status(err.status || 500).json({ error: 'upload_failed', message: err.message || 'Upload failed.' });
      }
    }

    const id = uid('crs_');
    const ts = now();
    db.prepare(
      `INSERT INTO academy_courses (id, author_id, title, summary, category, language, level, cover_media_id, published, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      req.user.id,
      title,
      clean(req.body.summary, 800),
      clean(req.body.category, 40) || 'general',
      clean(req.body.language, 12) || 'en',
      LEVELS.includes(req.body.level) ? req.body.level : 'beginner',
      coverMediaId,
      req.body.published === '0' || req.body.published === 'false' ? 0 : 1,
      ts,
      ts,
    );

    audit(req.user.id, 'academy.course.create', 'academy_course', id, { title });
    res.status(201).json({ course: serializeCourse(loadCourse(id), req.user.id) });
  },
);

router.get('/academy/courses/:id', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });
  if (!row.published && !canManage(req.user, row)) {
    return res.status(403).json({ error: 'forbidden', message: 'This course is not published.' });
  }
  res.json({ course: serializeCourse(row, req.user.id) });
});

router.patch('/academy/courses/:id', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });
  if (!canManage(req.user, row)) return res.status(403).json({ error: 'forbidden', message: 'You cannot edit this course.' });

  const title = req.body.title === undefined ? row.title : clean(req.body.title, 160);
  const summary = req.body.summary === undefined ? row.summary : clean(req.body.summary, 800);
  const category = req.body.category === undefined ? row.category : clean(req.body.category, 40);
  const language = req.body.language === undefined ? row.language : clean(req.body.language, 12);
  const level = LEVELS.includes(req.body.level) ? req.body.level : row.level;
  const published = req.body.published === undefined ? row.published : (req.body.published ? 1 : 0);

  db.prepare(
    'UPDATE academy_courses SET title = ?, summary = ?, category = ?, language = ?, level = ?, published = ?, updated_at = ? WHERE id = ?',
  ).run(title, summary, category, language, level, published, now(), row.id);

  audit(req.user.id, 'academy.course.update', 'academy_course', row.id, {});
  res.json({ course: serializeCourse(loadCourse(row.id), req.user.id) });
});

router.delete('/academy/courses/:id', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });
  if (!canManage(req.user, row)) return res.status(403).json({ error: 'forbidden', message: 'You cannot delete this course.' });
  // Deliberate, confirmed deletion only.
  if (req.query.confirm !== '1') {
    return res.status(428).json({ error: 'confirmation_required', message: 'Confirm deletion to remove this course.' });
  }
  db.prepare('UPDATE academy_courses SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), row.id);
  audit(req.user.id, 'academy.course.delete', 'academy_course', row.id, {});
  res.json({ ok: true });
});

/* --------------------------------- lessons -------------------------------- */

router.post('/academy/courses/:id/lessons', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });
  if (!canManage(req.user, row)) return res.status(403).json({ error: 'forbidden', message: 'You cannot add lessons here.' });

  const title = clean(req.body.title, 160);
  if (!title) return badRequest(res, 'A lesson needs a title.');

  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM academy_lessons WHERE course_id = ?').get(row.id).m;
  const id = uid('lsn_');
  const ts = now();
  db.prepare(
    'INSERT INTO academy_lessons (id, course_id, position, title, body, duration_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    id,
    row.id,
    max + 1,
    title,
    clean(req.body.body, 20000),
    req.body.durationMinutes === undefined ? null : clampInt(req.body.durationMinutes, 1, 600, 10),
    ts,
    ts,
  );
  db.prepare('UPDATE academy_courses SET updated_at = ? WHERE id = ?').run(ts, row.id);

  audit(req.user.id, 'academy.lesson.create', 'academy_lesson', id, { courseId: row.id });
  res.status(201).json({ course: serializeCourse(loadCourse(row.id), req.user.id) });
});

router.delete('/academy/courses/:id/lessons/:lessonId', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });
  if (!canManage(req.user, row)) return res.status(403).json({ error: 'forbidden', message: 'You cannot edit this course.' });

  const lesson = db
    .prepare('SELECT * FROM academy_lessons WHERE id = ? AND course_id = ? AND deleted_at IS NULL')
    .get(req.params.lessonId, row.id);
  if (!lesson) return res.status(404).json({ error: 'not_found', message: 'Lesson not found.' });

  db.prepare('UPDATE academy_lessons SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), lesson.id);
  res.json({ course: serializeCourse(loadCourse(row.id), req.user.id) });
});

/* ------------------------------- enrolment -------------------------------- */

router.post('/academy/courses/:id/enroll', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });
  if (!row.published) return res.status(403).json({ error: 'forbidden', message: 'This course is not published.' });

  const existing = db
    .prepare('SELECT * FROM academy_enrollments WHERE course_id = ? AND user_id = ?')
    .get(row.id, req.user.id);
  if (!existing) {
    const ts = now();
    db.prepare(
      'INSERT INTO academy_enrollments (course_id, user_id, completed_lesson_ids, progress, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run(row.id, req.user.id, '[]', 0, ts, ts);
  }
  res.json({ course: serializeCourse(loadCourse(row.id), req.user.id) });
});

router.post('/academy/courses/:id/progress', requireAuth, (req, res) => {
  const row = loadCourse(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Course not found.' });

  const lessonId = clean(req.body.lessonId, 60);
  const lesson = db
    .prepare('SELECT * FROM academy_lessons WHERE id = ? AND course_id = ? AND deleted_at IS NULL')
    .get(lessonId, row.id);
  if (!lesson) return res.status(404).json({ error: 'not_found', message: 'Lesson not found in this course.' });

  const enrollment =
    db.prepare('SELECT * FROM academy_enrollments WHERE course_id = ? AND user_id = ?').get(row.id, req.user.id) || null;

  const done = new Set(parseJSON(enrollment?.completed_lesson_ids, []));
  if (req.body.completed === false) done.delete(lesson.id);
  else done.add(lesson.id);

  const total = db
    .prepare('SELECT COUNT(*) c FROM academy_lessons WHERE course_id = ? AND deleted_at IS NULL')
    .get(row.id).c;
  const progress = total ? Math.round((done.size / total) * 100) : 0;
  const ts = now();

  if (enrollment) {
    db.prepare('UPDATE academy_enrollments SET completed_lesson_ids = ?, progress = ?, updated_at = ? WHERE course_id = ? AND user_id = ?')
      .run(JSON.stringify([...done]), progress, ts, row.id, req.user.id);
  } else {
    db.prepare(
      'INSERT INTO academy_enrollments (course_id, user_id, completed_lesson_ids, progress, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run(row.id, req.user.id, JSON.stringify([...done]), progress, ts, ts);
  }

  res.json({ course: serializeCourse(loadCourse(row.id), req.user.id) });
});

// Everything a device needs to read Academy offline. Authenticated, read-only.
router.get('/academy/offline-bundle', requireAuth, (req, res) => {
  const courses = db
    .prepare('SELECT * FROM academy_courses WHERE deleted_at IS NULL AND published = 1 ORDER BY updated_at DESC LIMIT 100')
    .all()
    .map((row) => serializeCourse(row, req.user.id));
  res.json({ courses, generatedAt: now() });
});

export default router;
