import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatTime } from '../api.js';
import { cacheFeed, readFeed, enqueue, newClientId } from '../localdb.js';
import { localPostFromDraft, mergePosts, visiblePosts } from '../feedcache.js';
import { useAuth } from '../App.jsx';
import { Avatar, ConfirmDialog, Empty, Field, Modal, Spinner, useToast, Badge } from '../ui.jsx';
import ModelViewer from '../components/ModelViewer.jsx';

const AUDIENCES = [
  { value: 'public', label: 'Public' },
  { value: 'friends', label: 'Friends' },
  { value: 'private', label: 'Only me' },
];

function detectKind(file) {
  if (!file) return 'text';
  const name = file.name.toLowerCase();
  if (name.endsWith('.glb') || name.endsWith('.gltf')) return 'model';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

function Composer({ onCreated, user }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('public');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function submit(event) {
    event.preventDefault();
    if (!body.trim() && !file) {
      toast.push('Write something or attach a file first.', 'error');
      return;
    }
    setBusy(true);
    const clientId = newClientId();
    try {
      const form = new FormData();
      form.append('body', body.trim());
      form.append('audience', audience);
      form.append('kind', detectKind(file));
      form.append('clientId', clientId);
      if (file) form.append('file', file);
      const data = await api('/posts', { method: 'POST', form });
      onCreated(data.post);
      setBody('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      toast.push(data.duplicate ? 'Already posted.' : 'Posted.', 'success');
    } catch (err) {
      // No connection: a text post is kept on this device and sent automatically.
      const offline = !navigator.onLine || !err.status;
      if (offline && !file) {
        const createdAt = new Date().toISOString();
        await enqueue({ clientId, type: 'post', body: body.trim(), audience, createdAt, attempts: 0 });
        // Store the post itself, not only the outbox entry. Closing the app must never
        // lose it: this row is what the feed renders from until the server accepts it.
        const localPost = localPostFromDraft({
          clientId,
          body: body.trim(),
          audience,
          createdAt,
          author: {
            id: user?.id || 'me',
            username: user?.username || '',
            fullName: user?.fullName || 'You',
            avatarUrl: user?.avatarUrl || null,
          },
        });
        await cacheFeed([localPost]);
        onCreated(localPost);
        setBody('');
        toast.push('Saved offline — will post automatically.', 'success');
      } else if (offline) {
        toast.push('Photos and videos need a connection. Your text can be saved offline without an attachment.', 'error');
      } else {
        toast.push(err.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card composer" onSubmit={submit}>
      <textarea
        className="input"
        placeholder="Share something with your network…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={5000}
        aria-label="Post text"
      />
      {file ? (
        <div className="row small muted" style={{ marginTop: 8 }}>
          <Badge tone="green">{detectKind(file)}</Badge>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</span>
          <button type="button" className="link-btn" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>Remove</button>
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
          Photo / video / 3D
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/*,video/*,.glb,.gltf"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <select className="input sm" style={{ width: 150 }} value={audience} onChange={(e) => setAudience(e.target.value)} aria-label="Audience">
          {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn primary" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : null} Post</button>
      </div>
    </form>
  );
}

function Comments({ postId, onCountChange }) {
  const { user } = useAuth();
  const toast = useToast();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/posts/${postId}/comments`);
      setComments(data.comments || []);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [postId, toast]);

  useEffect(() => { load(); }, [load]);

  async function add(event) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      const data = await api(`/posts/${postId}/comments`, { method: 'POST', body: { body: text.trim() } });
      setComments((prev) => [...prev, data.comment]);
      setText('');
      onCountChange?.(1);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    try {
      await api(`/comments/${id}`, { method: 'DELETE' });
      setComments((prev) => prev.filter((c) => c.id !== id));
      onCountChange?.(-1);
    } catch (err) {
      toast.push(err.message, 'error');
    }
  }

  return (
    <div className="comments">
      {loading ? <Spinner label="Loading comments" /> : null}
      {!loading && comments.length === 0 ? <div className="tiny muted">No comments yet.</div> : null}
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <Avatar user={c.author} size={28} />
          <div className="grow">
            <div className="row" style={{ gap: 6 }}>
              <Link to={`/u/${c.author?.username}`} className="tiny" style={{ fontWeight: 700 }}>{c.author?.fullName}</Link>
              <span className="tiny muted">{formatTime(c.createdAt)}</span>
            </div>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
          {c.author?.id === user.id ? (
            <button className="link-btn tiny" onClick={() => remove(c.id)}>Delete</button>
          ) : null}
        </div>
      ))}
      <form className="row" onSubmit={add} style={{ marginTop: 8 }}>
        <input className="input sm" placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
        <button className="btn sm primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

function PostCard({ post, onChange, onRemoved }) {
  const { user } = useAuth();
  const toast = useToast();
  const [showComments, setShowComments] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editBody, setEditBody] = useState(post.body || '');
  const [editAudience, setEditAudience] = useState(post.audience || 'public');
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [shareBusy, setShareBusy] = useState(false);

  // Optimistic like: no refetch, so the feed never jumps and scroll position is preserved.
  async function toggleLike() {
    const previous = { liked: post.likedByMe, likes: post.counts?.likes ?? 0 };
    onChange({ ...post, likedByMe: !previous.liked, counts: { ...post.counts, likes: previous.likes + (previous.liked ? -1 : 1) } });
    try {
      const data = await api(`/posts/${post.id}/like`, { method: 'POST' });
      const liked = typeof data.liked === 'boolean' ? data.liked : !previous.liked;
      const likes = typeof data.likes === 'number' ? data.likes : (data.counts?.likes ?? previous.likes + (liked ? 1 : -1));
      onChange({ ...post, likedByMe: liked, counts: { ...post.counts, likes } });
    } catch (err) {
      onChange({ ...post, likedByMe: previous.liked, counts: { ...post.counts, likes: previous.likes } });
      toast.push(err.message, 'error');
    }
  }

  async function saveEdit() {
    setBusy(true);
    try {
      const data = await api(`/posts/${post.id}`, { method: 'PATCH', body: { body: editBody, audience: editAudience } });
      onChange(data.post);
      setEditOpen(false);
      toast.push('Post updated.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      await api(`/posts/${post.id}`, { method: 'DELETE' });
      onRemoved(post.id);
      toast.push('Post deleted.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
      setBusy(false);
    }
  }

  async function share() {
    setShareBusy(true);
    try {
      const data = await api(`/posts/${post.id}/share`, { method: 'POST', body: {} });
      onChange({ ...post, counts: { ...post.counts, shares: (post.counts?.shares ?? 0) + 1 } });
      toast.push(data.post ? 'Shared to your feed.' : 'Shared.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setShareBusy(false);
    }
  }

  async function submitReport() {
    try {
      await api('/reports', { method: 'POST', body: { targetType: 'post', targetId: post.id, reason: reportReason, details: reportDetails } });
      setReportOpen(false);
      setReportDetails('');
      toast.push('Report submitted for moderation review.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    }
  }

  return (
    <article className="card post">
      <header className="row" style={{ alignItems: 'flex-start' }}>
        <Link to={`/u/${post.author?.username}`}><Avatar user={post.author} size={42} /></Link>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <Link to={`/u/${post.author?.username}`} style={{ fontWeight: 700 }}>{post.author?.fullName}</Link>
            {post.author?.isAi ? <Badge tone="green">#ash AI · verified</Badge> : null}
            {post.aiGenerated && !post.author?.isAi ? <Badge tone="grey">AI-generated</Badge> : null}
            {post.author?.isVerifiedSeller ? <Badge tone="green">Verified seller</Badge> : null}
          </div>
          <div className="tiny muted">
            @{post.author?.username} · {formatTime(post.createdAt)}
            {post.moderationStatus && post.moderationStatus !== 'visible' ? (
              <div className="banner warn tiny" style={{ marginTop: 8 }}>
                {post.moderationStatus === 'quarantined'
                  ? 'Hidden from other people while a moderator reviews this post. You can appeal in #ash AI → Safety.'
                  : 'This post was hidden by a moderator. You can appeal in #ash AI → Safety.'}
              </div>
            ) : null}
            {post.edited ? ' · edited' : ''} · {post.audience === 'private' ? 'Only me' : post.audience === 'friends' ? 'Friends' : 'Public'}
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn ghost sm" aria-label="Post menu" onClick={() => setMenuOpen((v) => !v)}>⋯</button>
          {menuOpen ? (
            <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
              {post.isOwner ? (
                <>
                  <button onClick={() => { setMenuOpen(false); setEditOpen(true); }}>Edit post</button>
                  <button className="danger-text" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>Delete post…</button>
                </>
              ) : (
                <>
                  <button onClick={() => { setMenuOpen(false); setReportOpen(true); }}>Report post</button>
                  <Link to={`/u/${post.author?.username}`} onClick={() => setMenuOpen(false)}>View profile</Link>
                </>
              )}
            </div>
          ) : null}
        </div>
      </header>

      {post.body ? <p className="post-body">{post.body}</p> : null}

      {post.mediaUrl && post.kind === 'image' ? (
        <img src={post.mediaUrl} alt="Post attachment" className="post-media" loading="lazy" />
      ) : null}
      {post.mediaUrl && post.kind === 'video' ? (
        <video src={post.mediaUrl} className="post-media" controls preload="metadata" />
      ) : null}
      {post.mediaUrl && post.kind === 'model' ? (
        <ModelViewer url={post.mediaUrl} />
      ) : null}
      {post.mediaUrl && !['image', 'video', 'model'].includes(post.kind) ? (
        <a className="btn ghost sm" href={post.mediaUrl} target="_blank" rel="noreferrer">Open attachment</a>
      ) : null}

      {post.sharedPost ? (
        <div className="card" style={{ background: 'var(--card-2)', marginTop: 10 }}>
          <div className="tiny muted">Shared from @{post.sharedPost.author?.username}</div>
          <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{post.sharedPost.body}</div>
          {post.sharedPost.mediaUrl && post.sharedPost.kind === 'image' ? (
            <img src={post.sharedPost.mediaUrl} alt="Shared attachment" className="post-media" loading="lazy" />
          ) : null}
        </div>
      ) : null}

      <div className="post-actions">
        <button className={`btn ghost sm ${post.likedByMe ? 'liked' : ''}`} onClick={toggleLike} aria-pressed={post.likedByMe}>
          ♥ {post.counts?.likes ?? 0}
        </button>
        <button className="btn ghost sm" onClick={() => setShowComments((v) => !v)}>
          💬 {post.counts?.comments ?? 0}
        </button>
        <button className="btn ghost sm" onClick={share} disabled={shareBusy}>↗ {post.counts?.shares ?? 0}</button>
      </div>

      {showComments ? (
        <Comments postId={post.id} onCountChange={(delta) => onChange({ ...post, counts: { ...post.counts, comments: Math.max(0, (post.counts?.comments ?? 0) + delta) } })} />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete this post?"
          message="This permanently removes the post, its comments and its likes. This cannot be undone."
          confirmLabel="Delete permanently"
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={doDelete}
        />
      ) : null}

      {editOpen ? (
        <Modal
          title="Edit post"
          onClose={() => setEditOpen(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setEditOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={saveEdit} disabled={busy}>Save changes</button>
            </>
          }
        >
          <Field label="Post text">
            <textarea className="input" rows={4} value={editBody} onChange={(e) => setEditBody(e.target.value)} maxLength={5000} />
          </Field>
          <Field label="Audience">
            <select className="input" value={editAudience} onChange={(e) => setEditAudience(e.target.value)}>
              {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </Field>
        </Modal>
      ) : null}

      {reportOpen ? (
        <Modal
          title="Report post"
          onClose={() => setReportOpen(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setReportOpen(false)}>Cancel</button>
              <button className="btn danger" onClick={submitReport}>Submit report</button>
            </>
          }
        >
          <Field label="Reason">
            <select className="input" value={reportReason} onChange={(e) => setReportReason(e.target.value)}>
              <option value="harassment">Harassment or bullying</option>
              <option value="hate">Hate speech</option>
              <option value="spam">Spam or scam</option>
              <option value="fraud">Fraud</option>
              <option value="violence">Violence</option>
              <option value="sexual">Sexual content</option>
              <option value="impersonation">Impersonation</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Details (optional)">
            <textarea className="input" rows={3} value={reportDetails} onChange={(e) => setReportDetails(e.target.value)} maxLength={1000} />
          </Field>
        </Modal>
      ) : null}
    </article>
  );
}

export default function Feed() {
  const { user } = useAuth();
  const toast = useToast();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async (nextCursor = null, append = false) => {
    // Show what this device already has before touching the network.
    const cached = append ? [] : visiblePosts(await readFeed());
    if (cached.length) {
      setPosts(cached);
      setLoading(false);
    }
    try {
      const data = await api(`/feed${nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : ''}`);
      const incoming = data.posts || [];
      // MERGE, never replace. A server page that does not contain a post created on this
      // device — still queued, or missing from a lagging read — must not remove it.
      setPosts((prev) => mergePosts(append ? prev : cached, incoming));
      setCursor(data.nextCursor || null);
      setOffline(false);
      if (!append) await cacheFeed(incoming);
    } catch (err) {
      // The request failed: keep everything already stored on the device.
      const local = visiblePosts(await readFeed());
      if (local.length) {
        setPosts(local);
        setOffline(true);
      } else {
        toast.push(err.message, 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="feed">
      <div className="welcome card">
        <div>
          <div className="tiny muted">Signed in as</div>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{user.fullName}</div>
          <div className="tiny muted">@{user.username} · {user.country || 'Location not set'}</div>
        </div>
        <Link to={`/u/${user.username}`} className="btn ghost sm">View profile</Link>
      </div>

      {offline ? (
        <div className="card" style={{ borderColor: 'var(--ash-amber, #ffc857)' }}>
          <strong className="small">Offline</strong>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            Showing posts saved on this device. New text posts are kept here and sent automatically when you are back online.
          </p>
        </div>
      ) : null}

      <Composer user={user} onCreated={(post) => setPosts((prev) => mergePosts([post, ...prev], []))} />

      {loading ? <Spinner label="Loading your feed" /> : null}
      {!loading && posts.length === 0 ? (
        <Empty title="Your feed is empty" hint="Create your first post, or find friends to follow their updates." action={<Link className="btn primary sm" to="/friends">Find friends</Link>} />
      ) : null}

      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onChange={(next) => setPosts((prev) => prev.map((p) => (p.id === next.id ? next : p)))}
          onRemoved={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
        />
      ))}

      {cursor ? (
        <button className="btn ghost block" onClick={() => load(cursor, true)}>Load older posts</button>
      ) : null}
    </div>
  );
}
