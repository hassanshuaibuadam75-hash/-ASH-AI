// #ash Mesh — nearby (device-to-device) transport.
//
// A browser cannot open Wi-Fi Aware, Wi-Fi Direct or Bluetooth LE sockets. Those radios
// are reached only through the native shell in `native/android` (AshMeshNativePlugin),
// which is injected into the WebView. This module is the client half of that contract:
//
//   bridge.capabilities()        -> { aware, direct, ble, lora, ... }
//   bridge.startDiscovery()      -> starts radio discovery
//   bridge.stopDiscovery()       -> stops it
//   bridge.peers()               -> [{ id, name, transport, rssi }]
//   bridge.send({ peerId, payload }) -> delivers a UTF-8 string frame
//
// Frames are plain JSON strings. Anything that cannot be delivered straight to a peer is
// kept in a relay queue and retried, so an offline device can hand its outbox to a nearby
// phone that does have internet (store-and-forward). Nothing here reads message plaintext:
// private messages travel as E2E envelopes produced by `crypto.js`, exactly as they do
// over the internet, so a relay only ever forwards ciphertext.
import { api } from './api.js';

const VERSION = 1;
const MAX_HOPS = 3;
const SEEN_LIMIT = 400;
const RELAY_KEY = 'ashmesh.relay.v1';
const EVENT = 'ashmesh:nearby';

const seen = new Set();
const seenOrder = [];

function remember(id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > SEEN_LIMIT) {
    const drop = seenOrder.splice(0, seenOrder.length - SEEN_LIMIT);
    for (const old of drop) seen.delete(old);
  }
  return true;
}

/* -------------------------------- the bridge ------------------------------ */

function rawBridge() {
  const direct = globalThis.AshMeshNative;
  if (direct && (typeof direct.send === 'function' || typeof direct.capabilities === 'function')) return direct;
  const cap = globalThis.Capacitor?.Plugins?.AshMeshNative;
  if (cap && (typeof cap.send === 'function' || typeof cap.capabilities === 'function')) return cap;
  return null;
}

async function call(method, args) {
  const bridge = rawBridge();
  if (!bridge || typeof bridge[method] !== 'function') return null;
  try {
    const value = await bridge[method](args);
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value ?? null;
  } catch {
    return null;
  }
}

// A radio is only reported as usable when the native shell says so. In a plain browser
// this is always false and the UI must not imply nearby networking is available.
export async function capabilities() {
  const caps = await call('capabilities');
  if (!caps || typeof caps !== 'object') {
    return { native: false, aware: false, direct: false, ble: false, lora: false };
  }
  return {
    native: true,
    aware: !!caps.aware,
    direct: !!caps.direct,
    ble: !!caps.ble,
    lora: !!caps.lora,
  };
}

export async function isNearbyAvailable() {
  const caps = await capabilities();
  return caps.native && (caps.aware || caps.direct || caps.ble);
}

export async function startDiscovery() {
  return call('startDiscovery');
}

export async function stopDiscovery() {
  return call('stopDiscovery');
}

export async function peers() {
  const list = await call('peers');
  return Array.isArray(list) ? list : [];
}

/* ------------------------------ relay consent ----------------------------- */

// Opt-in only. The app never uses a phone as a relay without this flag, and the flag can
// be revoked at any time from Network settings.
export function relayConsent() {
  try {
    return globalThis.localStorage?.getItem('ashmesh.relayConsent') === '1';
  } catch {
    return false;
  }
}

export function setRelayConsent(enabled) {
  try {
    globalThis.localStorage?.setItem('ashmesh.relayConsent', enabled ? '1' : '0');
  } catch {
    /* storage blocked — consent stays off for this session */
  }
  return !!enabled;
}

/* -------------------------------- framing -------------------------------- */

function readQueue() {
  try {
    const raw = globalThis.localStorage?.getItem(RELAY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    globalThis.localStorage?.setItem(RELAY_KEY, JSON.stringify(queue.slice(-200)));
  } catch {
    /* ignore quota errors — the durable outbox in IndexedDB still holds the data */
  }
}

export function pendingRelayCount() {
  return readQueue().length;
}

export function buildFrame({ type, item }) {
  return {
    v: VERSION,
    id: `${type}:${item?.clientId || item?.id || Math.random().toString(36).slice(2)}`,
    type,
    hops: 0,
    createdAt: new Date().toISOString(),
    item,
  };
}

async function transmit(frame) {
  const payload = JSON.stringify(frame);
  const known = await peers();
  const bridge = rawBridge();
  if (!bridge || !known.length) return false;
  let delivered = false;
  for (const peer of known) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('send', { peerId: peer.id, payload });
    if (res !== null && res !== false) delivered = true;
  }
  return delivered;
}

// Hand a queued outbox item to nearby peers. Returns how many were transmitted; items that
// could not go out stay in the outbox and in the relay queue for the next attempt.
export async function flushOutboxViaNearby(items = []) {
  if (!items.length) return { attempted: 0, relayed: 0 };
  const queue = readQueue();
  let relayed = 0;

  for (const item of items) {
    const frame = buildFrame({ type: item.type, item });
    if (!remember(frame.id)) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await transmit(frame);
    if (ok) {
      relayed += 1;
    } else if (!queue.some((q) => q.id === frame.id)) {
      queue.push(frame);
    }
  }

  writeQueue(queue);
  announce({ kind: 'relay', relayed, queued: queue.length });
  return { attempted: items.length, relayed };
}

/* --------------------------- receiving from peers -------------------------- */

// Frames arrive from the native shell as JSON. We de-duplicate by frame id, forward at most
// MAX_HOPS times, and — when this device has internet and relay consent — push the item to
// the server so it reaches the recipient. A relay never inspects message bodies.
export async function handleFrame(input) {
  let frame = input;
  if (typeof input === 'string') {
    try {
      frame = JSON.parse(input);
    } catch {
      return { accepted: false, reason: 'bad_frame' };
    }
  }
  if (!frame || frame.v !== VERSION || !frame.id) return { accepted: false, reason: 'bad_frame' };
  if (!remember(frame.id)) return { accepted: false, reason: 'duplicate' };

  const hops = Number(frame.hops || 0) + 1;
  if (hops <= MAX_HOPS) {
    await transmit({ ...frame, hops });
  }

  if (frame.type === 'outbox' && relayConsent()) {
    try {
      await relayToServer(frame.item);
      announce({ kind: 'relayed-to-server', id: frame.id });
      return { accepted: true, forwarded: true };
    } catch {
      return { accepted: true, forwarded: false };
    }
  }

  announce({ kind: 'received', id: frame.id, type: frame.type });
  return { accepted: true, forwarded: false };
}

async function relayToServer(item) {
  if (!item) throw new Error('empty item');
  switch (item.type) {
    case 'post':
      return api('/sync/push', {
        method: 'POST',
        body: {
          operations: [
            { clientId: item.clientId, type: 'post', body: item.body, audience: item.audience || 'public' },
          ],
        },
      });
    case 'comment':
      return api('/sync/push', {
        method: 'POST',
        body: { operations: [{ clientId: item.clientId, type: 'comment', postId: item.postId, body: item.body }] },
      });
    case 'like':
      return api('/sync/push', {
        method: 'POST',
        body: { operations: [{ clientId: item.clientId, type: 'like', postId: item.postId, liked: item.liked }] },
      });
    case 'message':
      return api(`/conversations/${item.conversationId}/messages`, {
        method: 'POST',
        body: {
          clientId: item.clientId,
          kind: item.kind || 'text',
          envelope: item.envelope,
          mediaId: item.mediaId || null,
          transport: 'nearby',
        },
      });
    default:
      throw new Error('unsupported_relay_type');
  }
}

function announce(detail) {
  try {
    globalThis.dispatchEvent(new CustomEvent(EVENT, { detail }));
  } catch {
    /* non-browser environment */
  }
}

// Bind the native shell's inbound channel. The shell dispatches this event; the browser
// simply ignores it because no bridge is present.
export function listenForPeers() {
  if (typeof globalThis.addEventListener !== 'function') return () => {};
  const onFrame = (event) => {
    handleFrame(event?.detail).catch(() => {});
  };
  globalThis.addEventListener('ashmesh:nearby-frame', onFrame);
  return () => globalThis.removeEventListener('ashmesh:nearby-frame', onFrame);
}

export const NEARBY_EVENT = EVENT;
