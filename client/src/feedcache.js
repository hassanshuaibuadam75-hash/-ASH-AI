// #ash Mesh — feed cache merge rules (pure, no browser APIs).
//
// A post created while offline exists in three possible shapes:
//
//   1. local placeholder  id === clientId, pending: true, transport: 'queued'
//   2. server copy        id === <uuid>,    clientId: <same clientId>
//   3. nothing yet        (outbox only — must never happen after this fix)
//
// Every rule below exists so that a post is never lost and never shown twice:
// the server copy replaces its own placeholder, a server response never removes a
// local-only post, and a failed request never deletes anything.

export const LOCAL_PREFIX = 'local:';

/** Stable identity for a post across its local and server lives. */
export function postKey(post) {
  if (!post) return '';
  return String(post.clientId || post.id || '');
}

export function isPending(post) {
  return !!post && (post.pending === true || post.transport === 'queued');
}

/** Newest known timestamp for ordering / last-writer-wins. */
function stamp(post) {
  return Date.parse(post?.updatedAt || post?.createdAt || 0) || 0;
}

export function sortPosts(posts) {
  return [...(posts || [])].sort((a, b) => {
    const diff = String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
    return diff !== 0 ? diff : String(postKey(b)).localeCompare(String(postKey(a)));
  });
}

/**
 * Build the local record for a post composed while offline.
 * It is cached immediately so closing the app cannot lose it.
 */
export function localPostFromDraft({ clientId, body, audience = 'public', createdAt, author, kind = 'text' }) {
  const at = createdAt || new Date().toISOString();
  return {
    id: `${LOCAL_PREFIX}${clientId}`,
    clientId,
    body: body || '',
    kind,
    audience,
    mediaUrl: null,
    createdAt: at,
    updatedAt: at,
    edited: false,
    author: author || { id: 'me', username: '', fullName: 'You' },
    likedByMe: false,
    counts: { likes: 0, comments: 0, shares: 0 },
    isOwner: true,
    pending: true,
    transport: 'queued',
  };
}

/**
 * Merge cached local rows with a server response.
 *
 * - A server row always replaces the local placeholder carrying the same clientId
 *   (and any placeholder that shares its id).
 * - A local row the server did not return is KEPT — a partial page, a lagging read
 *   replica or a failed request must never delete what this device already has.
 * - Tombstones win, so a deletion is not resurrected.
 */
export function mergePosts(localRows, incomingRows) {
  const byKey = new Map();

  for (const row of localRows || []) {
    const key = postKey(row);
    if (key) byKey.set(key, row);
  }

  for (const row of incomingRows || []) {
    if (!row) continue;
    const key = postKey(row);
    if (!key) continue;
    const local = byKey.get(key);
    if (!local) {
      byKey.set(key, row);
      continue;
    }
    if (row.deleted && !local.deleted) {
      byKey.set(key, row);
      continue;
    }
    if (local.deleted && !row.deleted) continue;
    // The server is authoritative for content; keep a local pending flag only when
    // the server has not acknowledged the write yet (it always has, if it returned the row).
    byKey.set(key, { ...local, ...row, pending: false });
  }

  return sortPosts([...byKey.values()]);
}

/**
 * After the outbox successfully posts an item: drop the placeholder and store the
 * server copy. Idempotent — replaying it cannot create a second row.
 */
export function reconcileSyncedPost(localRows, clientId, serverPost) {
  const rows = (localRows || []).filter((row) => {
    if (!row) return false;
    if (row.clientId && row.clientId === clientId) return false;
    if (row.id === `${LOCAL_PREFIX}${clientId}`) return false;
    if (row.id === clientId) return false;
    return true;
  });
  if (serverPost) rows.push({ ...serverPost, clientId: serverPost.clientId || clientId, pending: false });
  return mergePosts(rows, []);
}

/** Rows safe to render: cached posts minus tombstones. */
export function visiblePosts(rows) {
  return sortPosts((rows || []).filter((row) => row && !row.deleted));
}
