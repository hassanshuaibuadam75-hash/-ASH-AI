import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, formatTime } from '../api.js';
import { useAuth } from '../App.jsx';
import { Avatar, Badge, ConfirmDialog, Empty, Field, Modal, Spinner, useToast } from '../ui.jsx';
import ModelViewer from '../components/ModelViewer.jsx';

const LANGUAGES = [
  ['en', 'English'], ['ha', 'Hausa'], ['ig', 'Igbo'], ['yo', 'Yoruba'], ['ar', 'Arabic'],
  ['fr', 'French'], ['sw', 'Swahili'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['zh', 'Chinese'],
];

const PRIVACY_OPTIONS = [['public', 'Everyone'], ['friends', 'Friends only'], ['private', 'Only me']];

const emptyForm = {
  fullName: '', username: '', bio: '', phone: '', country: '', state: '', city: '',
  homeAddress: '', occupation: '', education: '', skills: '', interests: '', website: '',
  language: 'en', facebook: '', twitter: '', instagram: '', linkedin: '',
};

export default function Profile() {
  const { username } = useParams();
  const { user: me, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [posts, setPosts] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [privacy, setPrivacy] = useState({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reporting, setReporting] = useState(null);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [deletingPost, setDeletingPost] = useState(null);

  const isSelf = profile?.id === me.id;

  const load = useCallback(async () => {
    setError('');
    try {
      const [profileData, postData] = await Promise.all([
        api(`/users/${encodeURIComponent(username)}`),
        api(`/users/${encodeURIComponent(username)}/posts`).catch(() => ({ posts: [] })),
      ]);
      setProfile(profileData.user);
      setPosts(postData.posts || []);
      const p = profileData.user;
      setForm({
        fullName: p.fullName || '', username: p.username || '', bio: p.bio || '',
        phone: p.phone || '', country: p.country || '', state: p.state || '', city: p.city || '',
        homeAddress: p.homeAddress || '', occupation: p.occupation || '', education: p.education || '',
        skills: p.skills || '', interests: p.interests || '', website: p.website || '',
        language: p.language || 'en',
        facebook: p.socialLinks?.facebook || '', twitter: p.socialLinks?.twitter || '',
        instagram: p.socialLinks?.instagram || '', linkedin: p.socialLinks?.linkedin || '',
      });
      setPrivacy(p.privacy || {});
    } catch (err) {
      setError(err.message);
    }
  }, [username]);

  useEffect(() => { load(); }, [load]);

  async function uploadImage(kind, file) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      await api(`/users/me/${kind}`, { method: 'POST', form: body });
      await load();
      await refresh();
      toast.push(kind === 'avatar' ? 'Profile picture updated.' : 'Cover photo updated.', 'success');
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        socialLinks: {
          facebook: form.facebook, twitter: form.twitter,
          instagram: form.instagram, linkedin: form.linkedin,
        },
        privacy,
      };
      await api('/users/me', { method: 'PATCH', body: payload });
      setEditing(false);
      await load();
      await refresh();
      toast.push('Profile saved.', 'success');
      if (form.username && form.username !== username) navigate(`/u/${form.username}`);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function act(fn, message) {
    setBusy(true);
    try {
      await fn();
      if (message) toast.push(message, 'success');
      await load();
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function startConversation() {
    setBusy(true);
    try {
      const { conversationId } = await api('/conversations', { method: 'POST', body: { userId: profile.id } });
      navigate(`/messages?c=${conversationId}`);
    } catch (err) {
      toast.push(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Empty title="Profile unavailable" hint={error} action={<Link className="btn primary" to="/">Back to feed</Link>} />;
  if (!profile) return <Spinner label="Loading profile" />;

  const limited = profile.privacyLimited;

  return (
    <div className="stack">
      <div className="card profile-hero">
        <div className="cover" style={profile.coverUrl ? { backgroundImage: `url(${profile.coverUrl})` } : undefined}>
          {isSelf ? (
            <label className="cover-edit">
              {busy ? 'Uploading…' : 'Change cover'}
              <input type="file" accept="image/*" hidden onChange={(e) => uploadImage('cover', e.target.files?.[0])} />
            </label>
          ) : null}
        </div>
        <div className="profile-head">
          <label className={isSelf ? 'avatar-edit' : ''}>
            <Avatar user={profile} size={92} />
            {isSelf ? <input type="file" accept="image/*" hidden onChange={(e) => uploadImage('avatar', e.target.files?.[0])} /> : null}
          </label>
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2 style={{ margin: '0 0 2px' }}>
              {profile.fullName || profile.username}{' '}
              {profile.isFounder ? <Badge tone="green">Founder &amp; CEO</Badge> : null}
              {profile.verifiedSeller ? <Badge tone="green">Verified seller</Badge> : null}
            </h2>
            <div className="muted">@{profile.username}</div>
            {profile.bio ? <p style={{ marginTop: 8 }}>{profile.bio}</p> : null}
            <div className="row tiny muted" style={{ gap: 14, marginTop: 6 }}>
              <span>{profile.counts?.posts ?? 0} posts</span>
              <span>{profile.counts?.friends ?? 0} friends</span>
              {profile.createdAt ? <span>Joined {formatTime(profile.createdAt)}</span> : null}
            </div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {isSelf ? (
              <button className="btn primary" onClick={() => setEditing(true)}>Edit profile</button>
            ) : (
              <>
                <button className="btn primary" onClick={startConversation} disabled={busy}>Message</button>
                {profile.relationship === 'none' ? (
                  <button className="btn" disabled={busy} onClick={() => act(() => api('/friends/request', { method: 'POST', body: { userId: profile.id } }), 'Friend request sent.')}>Add friend</button>
                ) : null}
                {profile.relationship === 'friends' ? <Badge tone="green">Friends</Badge> : null}
                {profile.relationship === 'request_sent' ? <Badge tone="grey">Request sent</Badge> : null}
                {profile.relationship === 'request_received' ? <Link className="btn" to="/friends">Respond to request</Link> : null}
                <button className="btn ghost" onClick={() => setReporting('user')}>Report</button>
                <button className="btn ghost danger-text" onClick={() => setConfirmBlock(true)}>Block</button>
              </>
            )}
          </div>
        </div>
      </div>

      {!limited ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>About</h3>
          <div className="detail-grid">
            {profile.occupation ? <div><span className="tiny muted">Occupation</span><div>{profile.occupation}</div></div> : null}
            {profile.education ? <div><span className="tiny muted">Education</span><div>{profile.education}</div></div> : null}
            {profile.city || profile.country ? (
              <div><span className="tiny muted">Location</span><div>{[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}</div></div>
            ) : null}
            {profile.email ? <div><span className="tiny muted">Email</span><div>{profile.email}</div></div> : null}
            {profile.phone ? <div><span className="tiny muted">Phone</span><div>{profile.phone}</div></div> : null}
            {profile.skills ? <div><span className="tiny muted">Skills</span><div>{profile.skills}</div></div> : null}
            {profile.interests ? <div><span className="tiny muted">Interests</span><div>{profile.interests}</div></div> : null}
            {profile.website ? (
              <div><span className="tiny muted">Website</span><div><a href={profile.website} target="_blank" rel="noreferrer noopener">{profile.website}</a></div></div>
            ) : null}
            {profile.language ? <div><span className="tiny muted">Language</span><div>{profile.language}</div></div> : null}
          </div>
          {profile.socialLinks && Object.keys(profile.socialLinks).length ? (
            <div className="row wrap" style={{ gap: 10, marginTop: 14 }}>
              {Object.entries(profile.socialLinks).map(([key, value]) => (
                <a key={key} className="badge grey" href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noreferrer noopener">{key}</a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="card"><p className="muted" style={{ margin: 0 }}>This profile is private. Add them as a friend to see more.</p></div>
      )}

      <div className="stack">
        <h3 style={{ margin: '4px 2px' }}>Posts</h3>
        {posts.length === 0 ? <Empty title="No posts yet" hint={isSelf ? 'Share your first update from the feed.' : 'Nothing to show here.'} /> : null}
        {posts.map((post) => (
          <article className="card post" key={post.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row tiny muted">
                <span>{formatTime(post.createdAt)}</span>
                {post.audience !== 'public' ? <Badge tone="grey">{post.audience}</Badge> : null}
                {post.edited ? <span>edited</span> : null}
              </div>
              {post.isOwner ? (
                <button className="btn ghost sm danger-text" onClick={() => setDeletingPost(post)}>Delete</button>
              ) : null}
            </div>
            {post.body ? <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{post.body}</p> : null}
            {post.mediaUrl && post.kind === 'image' ? <img className="post-media" src={post.mediaUrl} alt="" loading="lazy" /> : null}
            {post.mediaUrl && post.kind === 'video' ? <video className="post-media" src={post.mediaUrl} controls preload="metadata" /> : null}
            {post.mediaUrl && post.kind === 'model' ? <ModelViewer url={post.mediaUrl} height={300} /> : null}
            <div className="row tiny muted" style={{ gap: 14, marginTop: 8 }}>
              <span>{post.counts.likes} likes</span>
              <span>{post.counts.comments} comments</span>
              <span>{post.counts.shares} shares</span>
            </div>
          </article>
        ))}
      </div>

      {editing ? (
        <Modal title="Edit profile" onClose={() => setEditing(false)}>
          <form onSubmit={saveProfile} className="stack">
            <div className="grid-2">
              <Field label="Full name"><input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} maxLength={120} /></Field>
              <Field label="Username" hint="3–24 letters, numbers, dot or underscore"><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
            </div>
            <Field label="Bio"><textarea rows={3} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} maxLength={600} /></Field>
            <div className="grid-2">
              <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <Field label="Website"><input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://example.com" /></Field>
              <Field label="Country"><input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></Field>
              <Field label="State"><input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></Field>
              <Field label="City"><input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
              <Field label="Home address" hint="Visible only to you"><input value={form.homeAddress} onChange={(e) => setForm({ ...form, homeAddress: e.target.value })} /></Field>
              <Field label="Occupation"><input value={form.occupation} onChange={(e) => setForm({ ...form, occupation: e.target.value })} /></Field>
              <Field label="Education"><input value={form.education} onChange={(e) => setForm({ ...form, education: e.target.value })} /></Field>
            </div>
            <Field label="Skills"><input value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} /></Field>
            <Field label="Interests"><input value={form.interests} onChange={(e) => setForm({ ...form, interests: e.target.value })} /></Field>
            <Field label="Preferred language">
              <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </Field>
            <div className="grid-2">
              <Field label="Facebook"><input value={form.facebook} onChange={(e) => setForm({ ...form, facebook: e.target.value })} /></Field>
              <Field label="X / Twitter"><input value={form.twitter} onChange={(e) => setForm({ ...form, twitter: e.target.value })} /></Field>
              <Field label="Instagram"><input value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} /></Field>
              <Field label="LinkedIn"><input value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} /></Field>
            </div>
            <h4 style={{ marginBottom: 0 }}>Privacy</h4>
            <div className="grid-2">
              {[['profile', 'Profile visibility'], ['phone', 'Phone number'], ['email', 'Email'], ['location', 'Location']].map(([key, label]) => (
                <Field key={key} label={label}>
                  <select value={privacy[key] || 'public'} onChange={(e) => setPrivacy({ ...privacy, [key]: e.target.value })}>
                    {PRIVACY_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  </select>
                </Field>
              ))}
              <Field label="Who can send friend requests">
                <select value={privacy.friendRequests || 'everyone'} onChange={(e) => setPrivacy({ ...privacy, friendRequests: e.target.value })}>
                  <option value="everyone">Everyone</option>
                  <option value="friends_of_friends">Friends of friends</option>
                  <option value="nobody">Nobody</option>
                </select>
              </Field>
              <Field label="Who can message you">
                <select value={privacy.messageRequests || 'everyone'} onChange={(e) => setPrivacy({ ...privacy, messageRequests: e.target.value })}>
                  <option value="everyone">Everyone</option>
                  <option value="friends">Friends only</option>
                  <option value="nobody">Nobody</option>
                </select>
              </Field>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn primary" disabled={saving}>{saving ? <span className="spinner" /> : 'Save changes'}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {confirmBlock ? (
        <ConfirmDialog
          title="Block this account"
          message="They will no longer be able to find your profile, message you or see your posts. Existing friendship is removed."
          confirmLabel="Block"
          busy={busy}
          onCancel={() => setConfirmBlock(false)}
          onConfirm={async () => {
            await act(() => api(`/blocks/${profile.id}`, { method: 'POST' }), 'Account blocked.');
            setConfirmBlock(false);
          }}
        />
      ) : null}

      {deletingPost ? (
        <ConfirmDialog
          title="Delete post"
          message="This permanently removes the post, its comments and likes. This cannot be undone."
          confirmLabel="Delete permanently"
          busy={busy}
          onCancel={() => setDeletingPost(null)}
          onConfirm={async () => {
            await act(() => api(`/posts/${deletingPost.id}`, { method: 'DELETE' }), 'Post deleted.');
            setDeletingPost(null);
          }}
        />
      ) : null}

      {reporting ? (
        <Modal title="Report account" onClose={() => setReporting(null)} actions={
          <>
            <button className="btn ghost" onClick={() => setReporting(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                await act(() => api('/reports', {
                  method: 'POST',
                  body: { targetType: 'user', targetId: profile.id, reason: reportReason, details: reportDetails },
                }), 'Report submitted for review.');
                setReporting(null);
                setReportDetails('');
              }}
            >Submit report</button>
          </>
        }>
          <Field label="Reason">
            <select value={reportReason} onChange={(e) => setReportReason(e.target.value)}>
              <option value="harassment">Harassment or bullying</option>
              <option value="impersonation">Impersonation</option>
              <option value="spam">Spam</option>
              <option value="fraud">Fraud or scam</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Details" hint="Visible only to moderators"><textarea rows={3} value={reportDetails} onChange={(e) => setReportDetails(e.target.value)} maxLength={1000} /></Field>
        </Modal>
      ) : null}
    </div>
  );
}
