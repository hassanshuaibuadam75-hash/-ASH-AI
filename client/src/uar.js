// #ash Mesh — Universal Adaptive Routing (UAR).
// Automatically picks the best available route; the user never selects a technology.
//
// Layers: 1 Internet · 2 Wi-Fi Aware (NAN) · 3 Wi-Fi Direct / BLE · 4 Offline queue · 5 optional LoRa
// Browser reality: only Layer 1 and the offline queue are available in a web page.
// Layers 2, 3 and 5 require the native Android plugin (native/android). We detect it and
// never pretend a browser has Wi-Fi Aware.
import { api } from './api.js';

export const ROUTE = {
  INTERNET: 'internet',
  NEARBY: 'nearby',
  OFFLINE: 'offline',
};

export const ROUTE_LABEL = {
  internet: 'Sent via Internet',
  nearby: 'Sent via #ash Nearby',
  offline: 'Saved Offline — Will Send Automatically',
};

export function nativeBridge() {
  const bridge = globalThis.AshMeshNative;
  return bridge && typeof bridge.getCapabilities === 'function' ? bridge : null;
}

export async function readCapabilities() {
  const bridge = nativeBridge();
  const caps = {
    internet: navigator.onLine,
    wifiAware: false,
    wifiDirect: false,
    ble: false,
    lora: false,
    battery: null,
    connection: navigator.connection?.effectiveType || 'unknown',
    platform: bridge ? 'native' : 'web',
  };

  if (bridge) {
    try {
      const native = await bridge.getCapabilities();
      Object.assign(caps, {
        wifiAware: !!native.wifiAware,
        wifiDirect: !!native.wifiDirect,
        ble: !!native.ble,
        lora: !!native.lora,
        platform: 'native',
      });
    } catch {
      /* keep browser-safe defaults */
    }
  }

  if (navigator.getBattery) {
    try {
      const battery = await navigator.getBattery();
      caps.battery = Math.round(battery.level * 100);
      caps.charging = battery.charging;
    } catch {
      /* battery API unavailable */
    }
  }
  return caps;
}

export function chooseRoute({ online, peers = 0, battery = null }) {
  if (online) return ROUTE.INTERNET;
  if (peers > 0) return ROUTE.NEARBY;
  return ROUTE.OFFLINE;
}

export function lowPower(battery) {
  return typeof battery === 'number' && battery < 20;
}

// Plain-language explanation of what the device can currently do.
export function describeCapabilities(caps) {
  const lines = [];
  lines.push(caps.internet ? 'Internet route available' : 'No internet connection');
  if (caps.platform === 'native') {
    lines.push(caps.wifiAware ? 'Wi-Fi Aware available' : 'Wi-Fi Aware not supported on this device');
    lines.push(caps.wifiDirect ? 'Wi-Fi Direct available' : 'Wi-Fi Direct not supported');
    lines.push(caps.ble ? 'Bluetooth LE available' : 'Bluetooth LE unavailable');
    if (caps.lora) lines.push('LoRa gateway available');
  } else {
    lines.push('Offline radio routing requires the #ash Mesh Android app');
  }
  if (typeof caps.battery === 'number') lines.push(`Battery ${caps.battery}%`);
  return lines;
}

// Tell the backend about the current route mix (no location, no identifiers beyond the account).
export async function reportRoute(route, meta = {}) {
  try {
    await api('/network/report', { method: 'POST', body: { route, ...meta } });
  } catch {
    /* telemetry must never break messaging */
  }
}

// ---- Offline queue (IndexedDB) -------------------------------------------------
const DB_NAME = 'ashmesh-queue';
const STORE = 'outbox';

function openQueue() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'clientId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueOutgoing(item) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...item, queuedAt: Date.now(), attempts: item.attempts || 0 });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listQueued() {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.queuedAt - b.queuedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function removeQueued(clientId) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(clientId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function bumpQueued(item) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...item, attempts: (item.attempts || 0) + 1, lastAttempt: Date.now() });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export function newClientId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
