// #ash Mesh — Stage E nearby transport contract test.
//
// The browser cannot open Wi-Fi Aware, Wi-Fi Direct or BLE. Those radios live behind the
// Capacitor plugin in native/android. The failure this suite guards against is a *contract
// drift*: the plugin exposes getCapabilities/startNearby/getPeers/sendNearby and emits
// "nearbyMessage", while an older injected bridge used capabilities/startDiscovery/peers/send
// and a DOM event. If the two halves disagree, a real device silently looks like a plain
// browser and nearby routing never starts — no error, just no networking.
//
// So: the client half is driven here against a fake bridge that reproduces the plugin's real
// method names, argument shapes and return shapes. The native half is checked for the source
// invariants that the two transport bugs violated.
//
// This is NOT a substitute for device testing. It proves the JS contract and the source
// invariants only; radio behaviour on two physical phones is unverified (see
// docs/STAGE-E-NATIVE-NEARBY.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = path.join(ROOT, 'native/android/app/src/main/java/com/ashmesh/app');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n        ↳ ${detail}` : ''}`);
  }
}

/* ------------------------------ browser stubs ----------------------------- */

// localStorage backs the relay queue; a Map keeps the run hermetic.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* ------------------------- the fake native plugin ------------------------- */

const calls = [];
let inboundListener = null;
let unsubscribeCount = 0;

function makePluginBridge(overrides = {}) {
  return {
    // Exactly the method names the Java plugin declares with @PluginMethod.
    getCapabilities: async () => ({
      wifiAware: true,
      wifiDirect: true,
      ble: true,
      lora: false,
      platform: 'native',
      sdk: 34,
      relayConsent: false,
      ...overrides.capabilities,
    }),
    startNearby: async () => { calls.push('startNearby'); return { started: true }; },
    stopNearby: async () => { calls.push('stopNearby'); return { started: false }; },
    getPeers: async () => ({ peers: [{ id: 'peer-1', name: 'Tecno', transport: 'aware', lastSeen: 1 }] }),
    sendNearby: async (args) => {
      calls.push({ method: 'sendNearby', args });
      return overrides.sendResult ?? { ok: true, transport: 'aware', bytes: String(args?.payload || '').length };
    },
    addListener: (eventName, cb) => {
      calls.push(`addListener:${eventName}`);
      if (eventName === 'nearbyMessage') inboundListener = cb;
      return { remove: async () => { unsubscribeCount += 1; } };
    },
  };
}

const nearby = await import('../client/src/nearby.js');

/* --------------------------- 1. no native shell --------------------------- */

delete globalThis.AshMeshNative;
delete globalThis.Capacitor;
const webCaps = await nearby.capabilities();
check(
  'a plain browser reports no native radios',
  webCaps.native === false && !webCaps.aware && !webCaps.direct && !webCaps.ble,
  JSON.stringify(webCaps),
);
check('a plain browser is not treated as nearby-capable', (await nearby.isNearbyAvailable()) === false);

/* ------------------- 2. detection of the real plugin ---------------------- */

globalThis.Capacitor = { Plugins: { AshMeshNative: makePluginBridge() } };
const nativeCaps = await nearby.capabilities();
check(
  'the Capacitor plugin is detected and its wifiAware/wifiDirect fields are normalised',
  nativeCaps.native === true && nativeCaps.aware === true && nativeCaps.direct === true && nativeCaps.ble === true,
  JSON.stringify(nativeCaps),
);
check('a device with radios is reported nearby-capable', (await nearby.isNearbyAvailable()) === true);

/* ------------------------ 3. discovery method names ----------------------- */

await nearby.startDiscovery();
check('startDiscovery calls the plugin\'s startNearby', calls.includes('startNearby'), JSON.stringify(calls));
await nearby.stopDiscovery();
check('stopDiscovery calls the plugin\'s stopNearby', calls.includes('stopNearby'), JSON.stringify(calls));

/* --------------------------- 4. peer shape ------------------------------- */

const peerList = await nearby.peers();
check(
  'peers() unwraps the plugin\'s { peers: [...] } envelope',
  Array.isArray(peerList) && peerList.length === 1 && peerList[0].id === 'peer-1',
  JSON.stringify(peerList),
);

/* ------------------- 5. outbound frames reach the plugin ----------------- */

const first = await nearby.flushOutboxViaNearby([
  { type: 'post', clientId: 'client-abc', body: 'Salam from Kano', audience: 'public' },
]);
const sent = calls.filter((c) => typeof c === 'object' && c.method === 'sendNearby').pop();
check('an outbox item is relayed over nearby', first.relayed === 1, JSON.stringify(first));
check(
  'the frame is addressed to a discovered peer with a JSON payload',
  !!sent && sent.args?.peerId === 'peer-1' && JSON.parse(sent.args.payload).type === 'post',
  JSON.stringify(sent?.args || null),
);
check(
  'the relayed frame carries the ciphertext-safe envelope, not plaintext routing metadata only',
  !!sent && JSON.parse(sent.args.payload).item.body === 'Salam from Kano',
);

/* --------------------- 6. inbound frames reach handleFrame --------------- */

const unsubscribe = nearby.listenForPeers();
check(
  'the client subscribes to the plugin\'s nearbyMessage event',
  calls.includes('addListener:nearbyMessage') && typeof inboundListener === 'function',
  JSON.stringify(calls.filter((c) => typeof c === 'string')),
);

const inboundFrame = {
  v: 1,
  id: 'outbox:inbound-1',
  type: 'post',
  hops: 0,
  createdAt: new Date().toISOString(),
  item: { type: 'post', clientId: 'inbound-1', body: 'nearby hello' },
};
inboundListener({ peerId: 'peer-1', payload: JSON.stringify(inboundFrame) });
await new Promise((r) => setTimeout(r, 50));

const replay = await nearby.handleFrame(inboundFrame);
check(
  'a frame delivered by the native listener is processed exactly once',
  replay.accepted === false && replay.reason === 'duplicate',
  JSON.stringify(replay),
);

unsubscribe();
check('unsubscribing removes the native listener', unsubscribeCount === 1, `removed=${unsubscribeCount}`);

/* ------------------ 7. a refused send is queued, not lost ---------------- */

globalThis.Capacitor = {
  Plugins: { AshMeshNative: makePluginBridge({ sendResult: { ok: false, reason: 'no_reachable_peer' } }) },
};
const before = nearby.pendingRelayCount();
const refused = await nearby.flushOutboxViaNearby([
  { type: 'post', clientId: 'client-refused', body: 'will wait for a peer' },
]);
check('a refused nearby send reports zero relayed', refused.relayed === 0, JSON.stringify(refused));
check(
  'a refused send stays in the relay queue for the next attempt',
  nearby.pendingRelayCount() > before,
  `before=${before} after=${nearby.pendingRelayCount()}`,
);

/* ---------------------- 8. native source invariants ---------------------- */

const direct = fs.readFileSync(path.join(JAVA, 'NearbyDirect.java'), 'utf8');
const ble = fs.readFileSync(path.join(JAVA, 'NearbyBle.java'), 'utf8');
const plugin = fs.readFileSync(path.join(JAVA, 'AshMeshNativePlugin.java'), 'utf8');

check(
  'Wi-Fi Direct does not dial a guessed group-owner address',
  !direct.includes('192.168.49.1'),
  'a hardcoded 192.168.49.1 sends frames to whichever device owns that IP',
);
check(
  'Wi-Fi Direct uses the group owner address reported by WifiP2pManager',
  direct.includes('groupOwnerAddress') && direct.includes('onConnectionInfo'),
);
check(
  'Wi-Fi Direct announces the local id once per connection, not per frame',
  (direct.match(/writeUTF/g) || []).length === 1,
  `writeUTF occurrences: ${(direct.match(/writeUTF/g) || []).length}`,
);
check(
  'Wi-Fi Direct retries a failed send instead of dropping the frame',
  /for \(int attempt = 0; attempt < 3; attempt\+\+\)/.test(direct),
);
check(
  'BLE sends through a GATT client write to the peer',
  ble.includes('connectGatt') && ble.includes('writeCharacteristic'),
);
check(
  'BLE no longer notifies its own write-only characteristic',
  !ble.includes('notifyCharacteristicChanged'),
);
check(
  'the plugin still exposes the method names the client calls',
  ['getCapabilities', 'startNearby', 'stopNearby', 'getPeers', 'sendNearby'].every((m) => plugin.includes(`void ${m}(`)),
);
check('the plugin emits nearbyMessage for inbound frames', plugin.includes('notifyListeners("nearbyMessage"'));

/* --------------------------------- result -------------------------------- */

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log(`${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
