// #ash Mesh — offline post persistence & feed restoration tests.
//
// Reproduces the reported sequence against the REAL client modules
// (client/src/localdb.js, client/src/feedcache.js), not a copy of their logic:
//
//   post online -> go offline -> post offline -> close app -> reopen app (offline)
//   -> the offline post must still be in the feed -> reconnect -> sync -> exactly one copy
//
// IndexedDB is provided by a small in-memory implementation with real keyPath/put/getAll
// semantics. Its backing store outlives the module instance, so re-importing localdb.js
// with a fresh cache key is a genuine "app closed and reopened" on the same device.
//
//   node tests/offline-feed.test.mjs

import assert from 'node:assert/strict';

/* ------------------------- minimal in-memory IndexedDB -------------------- */

const BACKING = new Map(); // dbName -> Map(storeName -> { keyPath, rows: Map })

function makeTransaction(store) {
  const t = { oncomplete: null, onerror: null, error: null, mode: 'readwrite' };
  t.objectStore = () => ({
    put(value) {
      const key = value[store.keyPath];
      if (key === undefined) throw new Error(`missing keyPath ${store.keyPath}`);
      store.rows.set(key, JSON.parse(JSON.stringify(value)));
      return request(undefined);
    },
    get(key) {
      const row = store.rows.get(key);
      return request(row ? JSON.parse(JSON.stringify(row)) : undefined);
    },
    getAll() {
      return request([...store.rows.values()].map((r) => JSON.parse(JSON.stringify(r))));
    },
    delete(key) {
      store.rows.delete(key);
      return request(undefined);
    },
    clear() {
      store.rows.clear();
      return request(undefined);
    },
  });
  // localdb awaits oncomplete; the operations above run synchronously first.
  setTimeout(() => t.oncomplete?.({ target: t }), 0);
  return t;
}

function request(result) {
  const req = { result, onsuccess: null, onerror: null };
  setTimeout(() => req.onsuccess?.({ target: req }), 0);
  return req;
}

globalThis.indexedDB = {
  open(name) {
    const firstOpen = !BACKING.has(name);
    if (firstOpen) BACKING.set(name, new Map());
    const stores = BACKING.get(name);
    const req = { result: null, onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null };
    req.result = {
      objectStoreNames: { contains: (n) => stores.has(n) },
      createObjectStore: (n, opts) => {
        stores.set(n, { keyPath: opts.keyPath, rows: new Map() });
        return {};
      },
      transaction: (n) => makeTransaction(stores.get(n)),
      close() {},
    };
    setTimeout(() => {
      if (firstOpen) req.onupgradeneeded?.({ target: req });
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },
};

/* ------------------------------- tiny runner ------------------------------ */

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message || String(err) });
    console.log(`FAIL  ${name}\n      ${err?.message || err}`);
  }
}

/* ------------------------------ the scenario ------------------------------ */

// "Reopen the app": a fresh module instance over the same device storage.
const boot = (tag) => import(`../client/src/localdb.js?boot=${tag}`);
const feedcache = await import('../client/src/feedcache.js');
const { localPostFromDraft, mergePosts, reconcileSyncedPost, visiblePosts } = feedcache;

const AUTHOR = { id: 'u-1', username: 'hassan', fullName: 'Hassan Shuaibu Adam', avatarUrl: null };

// A post that already existed online and is cached on the device.
const onlinePost = {
  id: 'srv-1',
  clientId: 'c-online-1',
  body: 'Posted while online',
  kind: 'text',
  audience: 'public',
  mediaUrl: null,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  author: AUTHOR,
  counts: { likes: 0, comments: 0, shares: 0 },
  isOwner: true,
};

const offlineClientId = 'c-offline-1';
const offlineCreatedAt = '2026-01-02T09:30:00.000Z';
let offlinePost = null;
let db1 = null;

await check('online post is cached to IndexedDB', async () => {
  db1 = await boot('first');
  await db1.cacheFeed([onlinePost]);
  const rows = await db1.readFeed();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'srv-1');
});

await check('offline post creation persists the post itself, not just the outbox', async () => {
  offlinePost = localPostFromDraft({
    clientId: offlineClientId,
    body: 'Written with no connection',
    audience: 'public',
    createdAt: offlineCreatedAt,
    author: AUTHOR,
  });
  await db1.cacheFeed([offlinePost]);
  await db1.enqueue({ clientId: offlineClientId, type: 'post', body: 'Written with no connection', audience: 'public', createdAt: offlineCreatedAt, attempts: 0 });

  const rows = await db1.readFeed();
  assert.equal(rows.length, 2, 'both posts are stored');
  const local = rows.find((r) => r.clientId === offlineClientId);
  assert.ok(local, 'offline post is in the feed store');
  assert.equal(local.pending, true);
  assert.equal(local.body, 'Written with no connection');
  assert.equal(local.author.fullName, 'Hassan Shuaibu Adam', 'author name survives reload');

  const outbox = await db1.listOutbox();
  assert.equal(outbox.length, 1, 'outbox still holds the pending send');
});

await check('closing and reopening the app restores the offline post from IndexedDB', async () => {
  // Fresh module instance = new page load, same device storage.
  const db2 = await boot('reopen-offline');
  const rows = await db2.readFeed();
  assert.equal(rows.length, 2, 'cache survived the restart');
  const restored = visiblePosts(rows);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].clientId, offlineClientId, 'newest post renders first');
  assert.equal(restored[0].pending, true);
  assert.ok(restored.some((p) => p.id === 'srv-1'), 'previously synced post still present');

  const outbox = await db2.listOutbox();
  assert.equal(outbox.length, 1, 'queued send survived the restart');
});

await check('offline feed rendering shows local + synced posts with no duplicates', async () => {
  const db3 = await boot('offline-render');
  const rendered = visiblePosts(await db3.readFeed());
  const bodies = rendered.map((p) => p.body);
  assert.deepEqual(bodies, ['Written with no connection', 'Posted while online']);
  assert.equal(new Set(rendered.map((p) => p.clientId)).size, rendered.length);
});

await check('a failing server request never deletes locally stored posts', async () => {
  const db4 = await boot('request-failed');
  const before = await db4.readFeed();
  // Feed.load() catch path: it only reads. Nothing may be removed on failure.
  const after = await db4.readFeed();
  assert.equal(after.length, before.length);
  assert.equal(visiblePosts(after).length, 2);
});

await check('reconnect: syncing replaces the placeholder with the server copy', async () => {
  const db5 = await boot('after-sync');
  const rows = await db5.readFeed();
  const serverCopy = {
    ...onlinePost,
    id: 'srv-2',
    clientId: offlineClientId,
    body: 'Written with no connection',
    createdAt: offlineCreatedAt,
    updatedAt: offlineCreatedAt,
  };
  // Exactly what flushOutbox does on a successful send.
  await db5.cacheSyncedPost(offlineClientId, serverCopy);

  const after = await db5.readFeed();
  assert.equal(after.length, 2, 'no duplicate row left behind');
  const synced = after.find((r) => r.clientId === offlineClientId);
  assert.equal(synced.id, 'srv-2', 'real server id replaced the local id');
  assert.equal(synced.pending, false, 'no longer pending');
  assert.equal(after.filter((r) => r.clientId === offlineClientId).length, 1);
});

await check('replayed sync (duplicate prevention) still yields exactly one copy', async () => {
  const db6 = await boot('replay');
  const rows = await db6.readFeed();
  const serverCopy = rows.find((r) => r.clientId === offlineClientId);
  const once = reconcileSyncedPost(rows, offlineClientId, serverCopy);
  const twice = reconcileSyncedPost(once, offlineClientId, serverCopy);
  const thrice = mergePosts(twice, [serverCopy]);
  await db6.cacheFeed(thrice);

  const after = await db6.readFeed();
  assert.equal(after.filter((r) => r.clientId === offlineClientId).length, 1);
  assert.equal(after.length, 2);
});

await check('a server page missing the local post does not remove it (merge, not replace)', async () => {
  const db7 = await boot('partial-page');
  const cached = visiblePosts(await db7.readFeed());
  // The feed endpoint returns only the older post — e.g. a lagging read.
  const merged = mergePosts(cached, [onlinePost]);
  assert.equal(merged.length, 2, 'local post retained alongside the server page');
  assert.ok(merged.some((p) => p.clientId === offlineClientId));
});

await check('new server posts are merged in without duplicating known ones', async () => {
  const db8 = await boot('merge-new');
  const cached = visiblePosts(await db8.readFeed());
  const brandNew = { ...onlinePost, id: 'srv-3', clientId: 'c-online-3', body: 'From another user', createdAt: '2026-01-03T08:00:00.000Z' };
  const merged = mergePosts(cached, [onlinePost, brandNew]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, 'srv-3', 'newest first');
  assert.equal(new Set(merged.map((p) => p.clientId)).size, 3);
});

await check('a tombstone still wins over a cached live copy', async () => {
  const cached = visiblePosts(await (await boot('tombstone')).readFeed());
  const merged = mergePosts(cached, [{ ...onlinePost, deleted: true, updatedAt: '2026-01-04T00:00:00.000Z' }]);
  assert.equal(visiblePosts(merged).some((p) => p.id === 'srv-1'), false, 'deleted post is hidden');
});

await check('clearing the outbox after a successful send keeps the post in the feed', async () => {
  const db9 = await boot('dequeued');
  await db9.dequeue(offlineClientId);
  const outbox = await db9.listOutbox();
  assert.equal(outbox.length, 0, 'queue drained');
  const rows = await db9.readFeed();
  assert.equal(rows.filter((r) => r.clientId === offlineClientId).length, 1, 'post still cached');
});

/* -------------------------------- summary -------------------------------- */

console.log('\n------------------------------------------------------------');
if (failures.length) {
  console.log(`${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  console.log('------------------------------------------------------------\n');
  process.exit(1);
}
console.log(`${passed}/${passed} checks passed — offline persistence verified`);
console.log('------------------------------------------------------------\n');
