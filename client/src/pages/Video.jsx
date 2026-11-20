// Video — a real feed of video posts, plus an honest note that Reels and Stories do not exist yet.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, mediaUrl, formatTime } from '../api.js';
import { Avatar, Empty, Spinner } from '../ui.jsx';

export default function Video() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api('/feed?kind=video&limit=20');
      setPosts(data.posts || []);
    } catch (err) {
      setError(err.message || 'Videos could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="center"><Spinner label="Loading videos" /></div>;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card">
        <div className="card-title">Video</div>
        <div className="small muted">
          Every video shared on #ash Mesh appears here. Reels and Stories are not implemented yet, so no Reels or
          Stories controls are shown.
        </div>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <Link className="btn sm" to="/">Share a video</Link>
          <button type="button" className="btn ghost sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {error ? <div className="card"><div className="small" style={{ color: '#ff9a9a' }}>{error}</div></div> : null}

      {!error && !posts.length ? (
        <Empty title="No videos yet" hint="Videos you or your friends share will show up here." />
      ) : null}

      {posts.map((post) => (
        <div className="card" key={post.id}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <Avatar user={post.author} size={36} />
            <div className="grow" style={{ minWidth: 0 }}>
              <Link to={`/u/${post.author.username}`} style={{ fontWeight: 700 }}>{post.author.fullName}</Link>
              <div className="tiny muted">@{post.author.username} · {formatTime(post.createdAt)}</div>
            </div>
          </div>
          {post.body ? <div className="small" style={{ marginTop: 8 }}>{post.body}</div> : null}
          {post.mediaUrl ? (
            <video src={mediaUrl(post.mediaId) || post.mediaUrl} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: 12, marginTop: 10 }} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
