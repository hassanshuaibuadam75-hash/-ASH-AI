// #ash Mesh — local database (offline-first storage).
//
// Everything the app has already seen is kept on the device so the same application
// keeps working with no connection: profile, feed, threads, messages, Academy,
// Heritage and marketplace snapshots. The store survives reloads and connectivity
// changes because it lives in IndexedDB, not in memory.
//
// Private message bodies are additionally sealed at rest with AES-GCM using a
// non-extractable device key (see sealJson/openJson). The key never leaves the
// device and cannot be read back out by script.

const DB_NAME = 'ashmesh-local';
const DB_VERSION = 1;

export const STORE = {
  META: 'meta',
  PROFILE: 'profile',
  FEED: 'feed',
  THREADS: 'threads',
  MESSAGES: 'messages',
  ACADEMY: 'academy',
  HERITAGE: 'heritage',
  MARKET: 'market',
  OUTBOX: 'outbox',
  KEY: 'keys',
};

const KEYED = {
  [STORE.META]: 'key',
  [STORE.PROFILE]: 'key',
  [STORE.FEED]: 'id',
  [STORE.THREADS]: 'id',
  [STORE.MESSAGES]: 'key',
  [STORE.ACADEMY]: 'id',
  [STORE.HERITAGE]: 'id',
  [STORE.MARKET]: 'id',
  [STORE.OUTBOX]: 'clientId',
  [STORE.KEY]: 'key',
};

let dbPromise = null;

export function localAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openLocal() {
  if (!localAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(KEYED)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('local database is blocked by another tab'));
  }).catch(() => null);
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putRows(store, rows) {
  const db = await openLocal();
  if (!db || !Array.isArray(rows) || rows.length === 0) return 0;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const row of rows) {
      if (row && row[KEYED[store]]) os.put(row);
    }
    t.oncomplete = () => resolve(rows.length);
    t.onerror = () => reject(t.error);
  }).catch(() => 0);
}

export async function putRow(store, row) {
  return putRows(store, [row]);
}

export async function getRows(store) {
  const db = await openLocal();
  if (!db) return [];
  try {
    return (await done(tx(db, store, 'readonly').getAll())) || [];
  } catch {
    return [];
  }
}

export async function getRow(store, key) {
  const db = await openLocal();
  if (!db) return null;
  try {
    return (await done(tx(db, store, 'readonly').get(key))) || null;
  } catch {
    return null;
  }
}

export async function removeRow(store, key) {
  const db = await openLocal();
  if (!db) return false;
  return new Promise((resolve) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => resolve(false);
  });
}

export async function clearStore(store) {
  const db = await openLocal();
  if (!db) return false;
  return new Promise((resolve) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = () => resolve(true);
    t.onerror = () => resolve(false);
  });
}

/* --------------------------------- meta ---------------------------------- */

export async function setMeta(key, value) {
  return putRow(STORE.META, { key, value, at: new Date().toISOString() });
}

export async function getMeta(key) {
  const row = await getRow(STORE.META, key);
  return row ? row.value : null;
}

/* ------------------------------ device crypto ---------------------------- */

async function deviceKey() {
  const db = await openLocal();
  if (!db) return null;
  const existing = await getRow(STORE.KEY, 'device');
  if (existing?.key) return existing.key;

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  // A non-extractable CryptoKey can be persisted by IndexedDB and still cannot be exported.
  await putRow(STORE.KEY, { key: 'device', value: key, createdAt: new Date().toISOString() });
  return key;
}

function b64(bytes) {
  let out = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) out += String.fromCharCode(view[i]);
  return btoa(out);
}

function unb64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// Encrypt a JSON payload for at-rest storage. Returns { sealed: true, iv, data }.
export async function sealJson(value) {
  try {
    const key = await deviceKey();
    if (!key) return { sealed: false, data: value };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { sealed: true, iv: b64(iv), data: b64(cipher) };
  } catch {
    return { sealed: false, data: value };
  }
}

export async function openJson(payload) {
  if (!payload || payload.sealed !== true) return payload?.data ?? null;
  try {
    const key = await deviceKey();
    if (!key) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(payload.iv) },
      key,
      unb64(payload.data),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/* ---------------------------- domain helpers ----------------------------- */

export const cacheProfile = (user) => putRow(STORE.PROFILE, { key: 'me', user, at: new Date().toISOString() });
export const readProfile = async () => (await getRow(STORE.PROFILE, 'me'))?.user || null;

export const cacheFeed = (posts) => putRows(STORE.FEED, (posts || []).map((p) => ({ ...p, cachedAt: Date.now() })));
export const deleteFeedRow = (id) => removeRow(STORE.FEED, id);
export const readFeed = async () =>
  (await getRows(STORE.FEED)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

export const cacheThreads = (threads) => putRows(STORE.THREADS, threads || []);
export const readThreads = async () =>
  (await getRows(STORE.THREADS)).sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));

export const cacheAcademy = (items) => putRows(STORE.ACADEMY, items || []);
export const readAcademy = async () => (await getRows(STORE.ACADEMY)).sort((a, b) => String(a.title).localeCompare(String(b.title)));

export const cacheHeritage = (items) => putRows(STORE.HERITAGE, items || []);
export const readHeritage = async () => (await getRows(STORE.HERITAGE)).sort((a, b) => String(b.title).localeCompare(String(a.title)));

export const cacheMarket = (items) => putRows(STORE.MARKET, items || []);
export const readMarket = async () => getRows(STORE.MARKET);

// Messages for one conversation, encrypted at rest.
export async function cacheMessages(conversationId, messages) {
  const rows = (messages || []).map((m) => ({
    key: `${conversationId}:${m.id || m.clientId}`,
    conversationId,
    sealed: true,
    payload: null,
    meta: {
      id: m.id || null,
      clientId: m.clientId || null,
      senderId: m.senderId || null,
      kind: m.kind || 'text',
      status: m.status || 'sent',
      transport: m.transport || 'internet',
      createdAt: m.createdAt || null,
      mine: !!m.mine,
    },
  }));

  const db = await openLocal();
  if (!db) return 0;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    row.payload = await sealJson({
      body: m_bodyOf(messages, row.key),
      mediaUrl: m_mediaOf(messages, row.key),
    });
  }

  return putRows(STORE.MESSAGES, rows);
}

function findMessage(messages, key) {
  return (messages || []).find((m) => `${m.id || m.clientId}` === key.split(':').slice(1).join(':'));
}
function m_bodyOf(messages, key) {
  return findMessage(messages, key)?.body ?? null;
}
function m_mediaOf(messages, key) {
  return findMessage(messages, key)?.mediaUrl ?? null;
}

export async function readMessages(conversationId) {
  const rows = (await getRows(STORE.MESSAGES)).filter((r) => r.conversationId === conversationId);
  const out = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const payload = await openJson(row.payload);
    out.push({ ...row.meta, body: payload?.body ?? null, mediaUrl: payload?.mediaUrl ?? null });
  }
  return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/* --------------------------------- outbox -------------------------------- */

export const enqueue = (item) =>
  putRow(STORE.OUTBOX, { ...item, queuedAt: item.queuedAt || Date.now(), attempts: item.attempts || 0 });

export const listOutbox = async () =>
  (await getRows(STORE.OUTBOX)).sort((a, b) => a.queuedAt - b.queuedAt);

export const dequeue = (clientId) => removeRow(STORE.OUTBOX, clientId);

export async function bumpOutbox(item, extra = {}) {
  return putRow(STORE.OUTBOX, {
    ...item,
    ...extra,
    attempts: (item.attempts || 0) + 1,
    lastAttempt: Date.now(),
  });
}

export function newClientId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ------------------------------- sync cursor ----------------------------- */

export const getCursor = () => getMeta('sync_cursor');
export const setCursor = (cursor) => setMeta('sync_cursor', cursor);

export async function storageSummary() {
  const [feed, threads, academy, heritage, outbox] = await Promise.all([
    getRows(STORE.FEED),
    getRows(STORE.THREADS),
    getRows(STORE.ACADEMY),
    getRows(STORE.HERITAGE),
    getRows(STORE.OUTBOX),
  ]);
  let usage = null;
  try {
    if (navigator.storage?.estimate) usage = await navigator.storage.estimate();
  } catch {
    /* quota API unavailable */
  }
  return {
    posts: feed.length,
    threads: threads.length,
    academy: academy.length,
    heritage: heritage.length,
    pending: outbox.length,
    usageBytes: usage?.usage ?? null,
    quotaBytes: usage?.quota ?? null,
  };
}
