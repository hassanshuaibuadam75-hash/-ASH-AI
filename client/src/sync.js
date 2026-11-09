// #ash Mesh — online/offline synchronisation engine.
//
// One application, two modes. While offline every action is written to the local
// database and an outbox entry is created. When a connection returns the outbox is
// replayed against the real API. Every outbox item carries a clientId, and the server
// is idempotent per clientId, so replaying after a partial failure can never create
// duplicate posts or messages.
//
// Pulling uses a server cursor (ISO timestamp). Incoming records are merged with
// last-writer-wins on updatedAt, so newer local edits are never overwritten by older
// server copies, and vice versa.
import { api } from './api.js';
import { mergePosts } from './feedcache.js';
import { flushOutboxViaNearby } from './nearby.js';
import {
  cacheAcademy,
  cacheFeed,
  cacheSyncedPost,
  cacheHeritage,
  cacheMarket,
  cacheProfile,
  cacheThreads,
  dequeue,
  bumpOutbox,
  getCursor,
  listOutbox,
  putRows,
  readFeed,
  setCursor,
  STORE,
} from './localdb.js';

export const EVENT = 'ashmesh:sync';

function announce(detail) {
  try {
    globalThis.dispatchEvent(new CustomEvent(EVENT, { detail }));
  } catch {
    /* non-browser environment */
  }
}

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/* ------------------------------ merge rules ------------------------------ */

// Newest updatedAt wins; a tombstone (deleted) always wins over a live copy so a
// deletion is never resurrected by an older cached row.
export function pickNewer(local, incoming) {
  if (!local) return incoming;
  if (!incoming) return local;
  if (incoming.deleted && !local.deleted) return incoming;
  if (local.deleted && !incoming.deleted) return local;
  const a = Date.parse(local.updatedAt || local.createdAt || 0) || 0;
  const b = Date.parse(incoming.updatedAt || incoming.createdAt || 0) || 0;
  return b >= a ? incoming : local;
}

export function mergeById(localRows, incomingRows) {
  const map = new Map((localRows || []).map((r) => [r.id, r]));
  for (const row of incomingRows || []) {
    if (!row?.id) continue;
    map.set(row.id, pickNewer(map.get(row.id), row));
  }
  return [...map.values()].sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
}

/* -------------------------------- outbox --------------------------------- */

const RETRYABLE = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

async function sendOutboxItem(item) {
  switch (item.type) {
    case 'post': {
      if (item.form) {
        const res = await api('/posts', { method: 'POST', form: item.form });
        return { ok: true, post: res.post };
      }
      const res = await api('/posts', {
        method: 'POST',
        body: { body: item.body, audience: item.audience, clientId: item.clientId },
      });
      return { ok: true, post: res.post };
    }
    case 'message': {
      const res = await api(`/conversations/${item.conversationId}/messages`, {
        method: 'POST',
        body: {
          clientId: item.clientId,
          kind: item.kind || 'text',
          envelope: item.envelope,
          mediaId: item.mediaId || null,
          transport: item.transport || 'queued',
        },
      });
      return { ok: true, message: res.message };
    }
    case 'profile': {
      const res = await api('/users/me', { method: 'PATCH', body: item.patch });
      return { ok: true, user: res.user };
    }
    case 'comment': {
      const res = await api(`/posts/${item.postId}/comments`, { method: 'POST', body: { body: item.body } });
      return { ok: true, comment: res.comment };
    }
    case 'like': {
      const res = await api(`/posts/${item.postId}/like`, { method: 'POST', body: { liked: item.liked } });
      return { ok: true, like: res };
    }
    default:
      return { ok: false, permanent: true, reason: 'unknown_type' };
  }
}

export async function flushOutbox({ limit = 25 } = {}) {
  if (!isOnline()) {
    // No internet: offer the queue to nearby peers (store-and-forward) and keep everything
    // locally. Items stay in the outbox until the server actually accepts them, so a relay
    // hand-off can never lose or duplicate an operation.
    const queue = (await listOutbox()).slice(0, limit);
    let relayed = 0;
    try {
      const result = await flushOutboxViaNearby(queue);
      relayed = result?.relayed || 0;
    } catch {
      relayed = 0;
    }
    if (relayed) announce({ kind: 'nearby', relayed });
    return { sent: 0, failed: 0, pending: (await listOutbox()).length, offline: true, relayed };
  }

  const queue = (await listOutbox()).slice(0, limit);
  let sent = 0;
  let failed = 0;

  for (const item of queue) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await sendOutboxItem(item);
      if (result.ok) {
        // Keep the cached copy in step with the server: replace the offline placeholder
        // with the accepted row, so the post survives a reload and is never shown twice.
        if (item.type === 'post' && result.post) {
          // eslint-disable-next-line no-await-in-loop
          await cacheSyncedPost(item.clientId, result.post);
        }
        // eslint-disable-next-line no-await-in-loop
        await dequeue(item.clientId);
        sent += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await bumpOutbox(item, { lastError: result.reason || 'rejected' });
        failed += 1;
      }
    } catch (err) {
      const status = Number(err?.status || 0);
      if (RETRYABLE.has(status) || status === 0) {
        // eslint-disable-next-line no-await-in-loop
        await bumpOutbox(item, { lastError: err?.message || 'network' });
        break; // connection is still down — keep the rest queued in order
      }
      // Permanent rejection (validation, permission): keep it visible, stop retrying.
      // eslint-disable-next-line no-await-in-loop
      await bumpOutbox(item, { lastError: err?.message || 'rejected', dead: true });
      failed += 1;
    }
  }

  if (sent || failed) announce({ kind: 'outbox', sent, failed });
  return { sent, failed, pending: (await listOutbox()).length, offline: false };
}

/* --------------------------------- pull ---------------------------------- */

export async function pullChanges() {
  if (!isOnline()) return { offline: true };

  const since = (await getCursor()) || '';
  const data = await api(`/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`);

  if (data.user) await cacheProfile(data.user);

  if (data.posts?.length) {
    const local = await readFeed();
    // mergePosts keys on clientId, so a pulled post replaces the offline placeholder it
    // came from instead of appearing next to it as a second row.
    await cacheFeed(mergePosts(local, data.posts));
  }
  if (data.threads?.length) await cacheThreads(data.threads);
  if (data.academy?.length) await cacheAcademy(data.academy);
  if (data.heritage?.length) await cacheHeritage(data.heritage);
  if (data.market?.length) await cacheMarket(data.market);
  if (data.messages?.length) await putRows(STORE.MESSAGES, data.messages);

  if (data.cursor) await setCursor(data.cursor);
  announce({ kind: 'pull', counts: {
    posts: data.posts?.length || 0,
    threads: data.threads?.length || 0,
    academy: data.academy?.length || 0,
    heritage: data.heritage?.length || 0,
  } });
  return data;
}

/* ------------------------------ orchestration ---------------------------- */

let running = null;

export async function syncNow() {
  if (running) return running;
  running = (async () => {
    try {
      const out = await flushOutbox();
      let pulled = null;
      if (!out.offline) {
        try {
          pulled = await pullChanges();
        } catch {
          /* keep local data when the pull fails */
        }
      }
      return { ...out, pulled: !!pulled };
    } finally {
      running = null;
    }
  })();
  return running;
}

export function startAutoSync() {
  if (typeof window === 'undefined') return () => {};
  const run = () => { syncNow().catch(() => {}); };

  window.addEventListener('online', run);
  window.addEventListener('focus', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  const timer = window.setInterval(run, 60000);
  run();

  return () => {
    window.removeEventListener('online', run);
    window.removeEventListener('focus', run);
    window.clearInterval(timer);
  };
}
