// #ash Mesh — client-side end-to-end encryption.
//
// Design (reviewed against the stated goals, documented honestly in SECURITY.md):
//  • Each device holds a non-extractable ECDH P-256 key pair in IndexedDB.
//  • A message key is derived with ECDH(myPrivateKey, peerPublicKey) → HKDF-SHA256
//    with a fresh random 16-byte salt, then AES-256-GCM with a fresh 12-byte IV.
//  • The server only ever receives {v, iv, ct, salt, pub}. It cannot derive the key.
//  • Attachments are encrypted with their own AES-GCM key; that key travels inside
//    the encrypted message payload, so file bytes and key are both unreadable to servers.
//  • Limitation (stated in the UI and docs): this is a static-DH scheme, not the Signal
//    double ratchet, so it does not provide post-compromise forward secrecy yet.
import { api } from './api.js';

const DB_NAME = 'ashmesh-e2e';
const STORE = 'keys';
const IDENTITY_KEY = 'identity';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export const b64 = {
  encode(bytes) {
    const arr = new Uint8Array(bytes);
    let str = '';
    for (let i = 0; i < arr.length; i += 1) str += String.fromCharCode(arr[i]);
    return btoa(str);
  },
  decode(value) {
    const str = atob(value);
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i += 1) arr[i] = str.charCodeAt(i);
    return arr;
  },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// Returns {publicKey, privateKey} (CryptoKey pair). Private key is non-extractable.
export async function ensureIdentity() {
  const existing = await idbGet(IDENTITY_KEY);
  if (existing?.privateKey && existing?.publicKey) {
    try {
      const jwk = await crypto.subtle.exportKey('jwk', existing.publicKey);
      await api('/users/me/public-key', { method: 'PUT', body: { publicKeyJwk: jwk } });
    } catch {
      /* offline: the key is retried on next app start */
    }
    return existing;
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
  const identity = { publicKey: pair.publicKey, privateKey: pair.privateKey, createdAt: Date.now() };
  await idbSet(IDENTITY_KEY, identity);
  try {
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    await api('/users/me/public-key', { method: 'PUT', body: { publicKeyJwk: jwk } });
  } catch {
    /* offline: retried later */
  }
  return identity;
}

export async function myPublicJwk() {
  const identity = await ensureIdentity();
  return crypto.subtle.exportKey('jwk', identity.publicKey);
}

async function importPeerKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

async function messageKey(privateKey, peerKey, salt) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('#ash-mesh/dm/v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt an arbitrary JSON payload for a peer's public JWK.
export async function encryptForPeer(peerPublicJwk, payload) {
  const identity = await ensureIdentity();
  const peerKey = await importPeerKey(peerPublicJwk);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await messageKey(identity.privateKey, peerKey, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  const myJwk = await crypto.subtle.exportKey('jwk', identity.publicKey);
  return { v: 1, iv: b64.encode(iv), ct: b64.encode(ct), salt: b64.encode(salt), pub: myJwk };
}

export async function decryptFromPeer(envelope) {
  if (!envelope?.ct || !envelope?.iv || !envelope?.salt || !envelope?.pub) throw new Error('Malformed encrypted message.');
  const identity = await ensureIdentity();
  const peerKey = await importPeerKey(envelope.pub);
  const salt = b64.decode(envelope.salt);
  const iv = b64.decode(envelope.iv);
  const key = await messageKey(identity.privateKey, peerKey, salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64.decode(envelope.ct));
  return JSON.parse(dec.decode(plain));
}

// Attachment encryption: returns the blob to upload plus the material the recipient needs.
export async function encryptFile(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw);
  const rawKey = await crypto.subtle.exportKey('raw', key);
  return {
    blob: new Blob([ct], { type: 'application/octet-stream' }),
    meta: {
      key: b64.encode(rawKey),
      iv: b64.encode(iv),
      name: file.name || 'attachment',
      mime: file.type || 'application/octet-stream',
      size: raw.length,
    },
  };
}

export async function decryptFile(arrayBuffer, meta) {
  const key = await crypto.subtle.importKey('raw', b64.decode(meta.key), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.decode(meta.iv) }, key, arrayBuffer);
  return new Blob([plain], { type: meta.mime || 'application/octet-stream' });
}
