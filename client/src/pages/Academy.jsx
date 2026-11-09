// #ash Mesh — #ash Academy (online + offline).
//
// Courses are real database records. When a connection exists the list is fetched and
// written into the local database, so the same screen keeps working with no signal:
// previously downloaded courses and lessons stay readable, and progress made offline is
// replayed through the sync engine when connectivity returns.
import React, { useCallback, useEffect, useState } from 'react';
import { api, formatTime } from '../api.js';
import { Avatar, Badge, ConfirmDialog, Empty, Field, Modal, Spinner, useToast } from '../ui.jsx';
import { useAuth } from '../App.jsx';
import { cacheAcademy, readAcademy } from '../localdb.js';

const LEVELS = ['beginner', 'intermediate', 'advanced'];

export default function Academy() {
  const { user } = useAuth();
  const toast = useToast();
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (mine) params.set('mine', '1');
    try {
      const data = await api(`/academy/courses?${params.toString()}`);
      setCourses(data.courses || []);
      setOffline(false);
      if (!query && !mine) await cacheAcademy(data.courses || []);
    } catch {
      // No connection: fall back to what this device already downloaded.
      const cached = await readAcademy();
      setCourses(cached);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [query, mine]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <h2 className="h2">#ash Academy</h2>
            <p className="muted small">Learn, teach and keep the knowledge on your device.</p>
          </div>
          <button className="btn primary" onClick={() => setCreating(true)} disabled={offline}>
            + New course
          </button>
        </div>

        <div className="row gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Search courses"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className={`btn ${mine ? 'primary' : ''}`} onClick={() => setMine((v) => !v)}>
            {mine ? 'My courses' : 'All courses'}
          </button>
        </div>

        {offline && (
          <p className="small" style={{ marginTop: 10, color: 'var(--ash-amber, #ffc857)' }}>
            Saved offline — showing courses downloaded to this device.
          </p>
        )}
      </div>

      {loading ? (
        <Spinner label="Loading courses" />
      ) : courses.length === 0 ? (
        <Empty
          title="No courses yet"
          hint={offline ? 'Courses you download will be readable here without internet.' : 'Publish the first course.'}
        />
      ) : (
        <div className="stack">
          {courses.map((course) => (
            <button key={course.id} className="card" style={{ textAlign: 'left' }} onClick={() => setOpen(course.id)}>
              <div className="row between">
                <strong>{course.title}</strong>
                <Badge tone="green">{course.level}</Badge>
              </div>
              <p className="muted small" style={{ margin: '6px 0' }}>{course.summary}</p>
              <div className="row gap small muted">
                <span>{course.lessonCount} lessons</span>
                {course.totalMinutes > 0 && <span>· {course.totalMinutes} min</span>}
                {course.enrolled && <span>· {course.progress}% complete</span>}
                <span>· {course.category}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {creating && <CreateCourse onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} toast={toast} />}
      {open && (
        <CourseDetail
          id={open}
          me={user}
          offline={offline}
          onClose={() => setOpen(null)}
          onChanged={load}
          toast={toast}
        />
      )}
    </div>
  );
}

function CreateCourse({ onClose, onCreated, toast }) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [category, setCategory] = useState('general');
  const [level, setLevel] = useState('beginner');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (title.trim().length < 3) return toast.push('Give the course a title of at least 3 characters.', 'error');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('title', title.trim());
      form.append('summary', summary.trim());
      form.append('category', category);
      form.append('level', level);
      if (file) form.append('file', file);
      await api('/academy/courses', { method: 'POST', form });
      toast.push('Course published');
      onCreated();
    } catch (err) {
      toast.push(err.message || 'Could not publish the course', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New course"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</button>
        </>
      }
    >
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Introduction to solar power" />
      </Field>
      <Field label="Summary">
        <textarea className="input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <Field label="Category">
        <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
      </Field>
      <Field label="Level">
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
      <Field label="Cover image (optional)">
        <input className="input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </Field>
    </Modal>
  );
}

function CourseDetail({ id, me, offline, onClose, onChanged, toast }) {
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api(`/academy/courses/${id}`);
      setCourse(data.course);
    } catch {
      const cached = await readAcademy();
      setCourse(cached.find((c) => c.id === id) || null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function enroll() {
    try {
      const data = await api(`/academy/courses/${id}/enroll`, { method: 'POST' });
      setCourse(data.course);
      onChanged?.();
    } catch (err) {
      toast.push(err.message || 'Could not enrol', 'error');
    }
  }

  async function toggleLesson(lesson) {
    const done = course.completedLessonIds?.includes(lesson.id);
    try {
      const data = await api(`/academy/courses/${id}/progress`, {
        method: 'POST',
        body: { lessonId: lesson.id, completed: !done },
      });
      setCourse(data.course);
      onChanged?.();
    } catch (err) {
      toast.push(err.message || 'Could not save progress', 'error');
    }
  }

  async function remove() {
    try {
      await api(`/academy/courses/${id}?confirm=1`, { method: 'DELETE' });
      toast.push('Course deleted');
      onChanged?.();
      onClose();
    } catch (err) {
      toast.push(err.message || 'Could not delete the course', 'error');
    }
  }

  return (
    <Modal
      title={course?.title || 'Course'}
      onClose={onClose}
      actions={
        <>
          {course?.isOwner && (
            <button className="btn danger" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
          {!course?.enrolled && course && <button className="btn primary" onClick={enroll} disabled={offline}>Enrol</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      {loading ? (
        <Spinner label="Loading course" />
      ) : !course ? (
        <Empty title="Course unavailable" hint="This course is not stored on this device." />
      ) : (
        <>
          <div className="row gap" style={{ alignItems: 'center' }}>
            <Avatar user={course.author} size={32} />
            <div>
              <strong>{course.author?.fullName || course.author?.username}</strong>
              <div className="muted small">{formatTime(course.createdAt)}</div>
            </div>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>{course.summary}</p>

          {course.enrolled && (
            <div className="row gap small" style={{ margin: '8px 0' }}>
              <Badge tone="green">{course.progress}% complete</Badge>
              <span className="muted">{course.completedLessonIds?.length || 0}/{course.lessonCount} lessons</span>
            </div>
          )}

          <div className="stack" style={{ marginTop: 12 }}>
            {course.lessons?.length ? (
              course.lessons.map((lesson, index) => {
                const done = course.completedLessonIds?.includes(lesson.id);
                return (
                  <div key={lesson.id} className="card" style={{ background: 'var(--ash-card-2, #0f231a)' }}>
                    <div className="row between">
                      <strong>{index + 1}. {lesson.title}</strong>
                      {course.enrolled && (
                        <button className={`btn small ${done ? 'primary' : ''}`} onClick={() => toggleLesson(lesson)} disabled={offline}>
                          {done ? '✓ Done' : 'Mark done'}
                        </button>
                      )}
                    </div>
                    {lesson.body && <p className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{lesson.body}</p>}
                  </div>
                );
              })
            ) : (
              <Empty title="No lessons yet" hint={course.isOwner ? 'Add the first lesson.' : 'The author has not added lessons.'} />
            )}
          </div>

          {course.isOwner && !offline && (
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add lesson</button>
          )}

          {adding && (
            <AddLesson
              courseId={course.id}
              onClose={() => setAdding(false)}
              onAdded={(updated) => { setCourse(updated); setAdding(false); onChanged?.(); }}
              toast={toast}
            />
          )}

          {confirmDelete && (
            <ConfirmDialog
              title="Delete this course?"
              message="The course and its lessons will be removed for everyone."
              confirmLabel="Delete course"
              onCancel={() => setConfirmDelete(false)}
              onConfirm={remove}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function AddLesson({ courseId, onClose, onAdded, toast }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim()) return toast.push('A lesson needs a title.', 'error');
    setBusy(true);
    try {
      const data = await api(`/academy/courses/${courseId}/lessons`, {
        method: 'POST',
        body: { title: title.trim(), body: body.trim(), durationMinutes: minutes ? Number(minutes) : null },
      });
      onAdded(data.course);
    } catch (err) {
      toast.push(err.message || 'Could not add the lesson', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add lesson"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save lesson'}</button>
        </>
      }
    >
      <Field label="Lesson title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Lesson content">
        <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Field label="Duration (minutes)">
        <input className="input" type="number" min="0" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </Field>
    </Modal>
  );
}
