// #ash Mesh — offline queue for AI-authorized actions.
//
// When a user approves an AI-assisted post/comment/like/share while the device is
// offline, the approved action is stored here and replayed when connectivity returns.
// Every queued action carries a stable clientId, so a replay can never create a
// duplicate: the server rejects/returns the existing record for a repeated clientId.
//
// This module owns its own IndexedDB database so it cannot disturb the feed,
// message or outbox stores used by the rest of the offline layer.

const DB_NAME = 'ashmesh-ai-queue';
const STORE_NAME = 'actions';
const VERSION = 1;

let dbPromise = null;

export function queueAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export function newClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `aia_${crypto.randomUUID()}`;
  }
  return `aia_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function openQueue() {
  if (!queueAvailable()) {
    return Promise.reject(new Error('This browser cannot store offline actions.'));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'clientId' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the offline action queue.'));
    });
  }
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline queue request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline queue transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline queue transaction was aborted.'));
  });
}

async function withStore(mode, work) {
  const database = await openQueue();
  const transaction = database.transaction(STORE_NAME, mode);
  const done = transactionDone(transaction);
  const result = await work(transaction.objectStore(STORE_NAME));
  await done;
  return result;
}

/**
 * Store an approved action. Passing an existing clientId overwrites that entry,
 * so repeated taps cannot enqueue the same action twice.
 */
export async function enqueue(action) {
  const record = {
    ...action,
    clientId: action.clientId || newClientId(),
    createdAt: action.createdAt || new Date().toISOString(),
    attempts: Number(action.attempts || 0),
  };
  await withStore('readwrite', (store) => requestResult(store.put(record)));
  return record;
}

export async function list() {
  const rows = await withStore('readonly', (store) => requestResult(store.getAll()));
  return (rows || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function count() {
  return (await list()).length;
}

export async function has(clientId) {
  const row = await withStore('readonly', (store) => requestResult(store.get(clientId)));
  return !!row;
}

export async function remove(clientId) {
  await withStore('readwrite', (store) => requestResult(store.delete(clientId)));
}

export async function clear() {
  await withStore('readwrite', (store) => requestResult(store.clear()));
}

/**
 * Replay queued actions through `send`. A successful send removes the entry; a
 * failed one stays queued with an incremented attempt counter so nothing is lost.
 * Returns a summary the UI can display honestly.
 */
export async function flush(send, { limit = 20 } = {}) {
  const pending = await list();
  let sent = 0;
  const failed = [];

  for (const action of pending.slice(0, limit)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await send(action);
      // eslint-disable-next-line no-await-in-loop
      await remove(action.clientId);
      sent += 1;
    } catch (err) {
      failed.push({ clientId: action.clientId, message: err?.message || 'Send failed.' });
      try {
        // eslint-disable-next-line no-await-in-loop
        await enqueue({ ...action, attempts: Number(action.attempts || 0) + 1 });
      } catch {
        /* keep the original entry if the rewrite fails */
      }
    }
  }

  return { sent, failed, remaining: (await list()).length };
}
