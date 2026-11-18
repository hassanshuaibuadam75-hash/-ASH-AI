# Stage E — Native Android Nearby Mesh

**Status:** implemented in source, contract-tested, **not device-verified**.
**Environment:** TEST only. No APK was built, no LIVE change, no purchase.

The honest summary: the nearby mesh is real code with a real radio path, but nobody has
watched it carry a message between two physical phones. Everything below states which half
of that sentence is evidenced.

---

## 1. What the nearby mesh is made of

| Layer | File | Role |
| --- | --- | --- |
| Client contract | `client/src/nearby.js` | frame format, relay queue, de-duplication, inbound binding |
| Route selection | `client/src/uar.js` | Universal Adaptive Routing: picks a route, reports a plain status |
| Plugin surface | `native/android/.../AshMeshNativePlugin.java` | the only JS↔native boundary |
| Wi-Fi Aware (NAN) | `NearbyAware.java` | publish/subscribe, preferred transport |
| Wi-Fi Direct (P2P) | `NearbyDirect.java` | higher-bandwidth fallback |
| Bluetooth LE | `NearbyBle.java` | discovery and low-power frames |
| Native shell config | `native/capacitor.config.json` | registers the plugin in the WebView |

A browser cannot open any of these radios. In a plain browser `capabilities()` returns
`native:false` and the UI must not claim nearby networking — asserted by the contract test.

Frames are JSON with `{ v, id, type, hops, createdAt, item }`. Private messages travel
inside the same E2E envelope `crypto.js` produces for the internet path, so a relay device
only ever forwards ciphertext. `MAX_HOPS` is 3 and every frame id is remembered once, which
is what prevents a store-and-forward loop.

---

## 2. Defects found and fixed in this stage

These were not cosmetic. Items 1–3 meant the mesh could not work at all on a real device,
and items 4–7 were transport bugs that would corrupt or drop traffic once it started.

1. **The client could not see the plugin.** `rawBridge()` only recognised `send` and
   `capabilities`, but `AshMeshNativePlugin` declares `getCapabilities`, `startNearby`,
   `stopNearby`, `getPeers`, `sendNearby`. On a real phone the bridge looked absent, so
   routing silently stayed on the internet path with no error. Detection now accepts either
   surface.
2. **Method names disagreed.** The client called `capabilities`/`startDiscovery`/`peers`/
   `send`. Added ordered fallback chains (`callFirst`) plus capability normalisation
   (`wifiAware`/`wifiDirect` → `aware`/`direct`) and unwrapping of the plugin's
   `{ peers: [...] }` envelope.
3. **Inbound frames were never received.** The plugin emits a Capacitor listener event
   `nearbyMessage` with `{ peerId, payload }`; the client only listened for a DOM event, and
   returned early when `addEventListener` was unavailable — which skipped the native binding
   entirely. `listenForPeers()` now binds both channels independently and returns a teardown.
4. **Wi-Fi Direct corrupted its own stream.** `send()` wrote `writeUTF(localId())` on every
   frame while `readLoop` reads the id once per connection, so every frame after the first
   shifted the stream. The id is now written once per connection.
5. **Wi-Fi Direct dialled a guessed address.** A hardcoded `192.168.49.1` sent frames to
   whichever device happened to own that IP. Now uses `groupOwnerAddress` from
   `onConnectionInfo(WifiP2pInfo)` and refuses to send when the group is not formed, instead
   of guessing.
6. **Wi-Fi Direct dropped frames on failure.** A single failure killed the connection. Now a
   bounded three-attempt reconnect with backoff, preserving the frame.
7. **BLE talked to itself.** `send()` called `notifyCharacteristicChanged` on its own
   write-only RX characteristic, which can never reach a peer. Now a GATT client connects to
   the peer and writes to its RX characteristic, closing on `stop()`.
8. **Route selection ignored the Capacitor shell.** `uar.js` only checked
   `globalThis.AshMeshNative`; it now also checks `Capacitor.Plugins.AshMeshNative`.

---

## 3. Evidence: `tests/nearby-contract.test.mjs` — 23/23

The test drives the real client module against a fake bridge that reproduces the plugin's
actual method names, argument shapes and return shapes, then asserts the Java invariants that
the bugs above violated.

```
PASS  a plain browser reports no native radios
PASS  a plain browser is not treated as nearby-capable
PASS  the Capacitor plugin is detected and its wifiAware/wifiDirect fields are normalised
PASS  a device with radios is reported nearby-capable
PASS  startDiscovery calls the plugin's startNearby
PASS  stopDiscovery calls the plugin's stopNearby
PASS  peers() unwraps the plugin's { peers: [...] } envelope
PASS  an outbox item is relayed over nearby
PASS  the frame is addressed to a discovered peer with a JSON payload
PASS  the relayed frame carries the ciphertext-safe envelope, not plaintext routing metadata only
PASS  the client subscribes to the plugin's nearbyMessage event
PASS  a frame delivered by the native listener is processed exactly once
PASS  unsubscribing removes the native listener
PASS  a refused nearby send reports zero relayed
PASS  a refused send stays in the relay queue for the next attempt
PASS  Wi-Fi Direct does not dial a guessed group-owner address
PASS  Wi-Fi Direct uses the group owner address reported by WifiP2pManager
PASS  Wi-Fi Direct announces the local id once per connection, not per frame
PASS  Wi-Fi Direct retries a failed send instead of dropping the frame
PASS  BLE sends through a GATT client write to the peer
PASS  BLE no longer notifies its own write-only characteristic
PASS  the plugin still exposes the method names the client calls
PASS  the plugin emits nearbyMessage for inbound frames
23/23 checks passed
```

Full suite in the same run: API end-to-end, offline feed, moderation, Founder editor,
Founder discoverability, commission boundaries, backup drill, archive drill (54/54),
wallet ledger (71/71), security hardening (26/26), nearby contract (23/23), then
`vite build` — all passing.

**What this proves:** the two halves agree on names, shapes and events; frames survive the
round trip through the client; a refused send is queued rather than lost; the specific
transport bugs cannot silently return.
**What this does not prove:** that a radio opened, a peer was discovered, or a byte crossed
a room.

---

## 4. Not verified — physical device testing

Per the Stage E acceptance criteria this stage is **not** complete. It needs:

- **Android SDK + Capacitor CLI** to produce an APK. Neither is available in this
  environment, so no APK was built. `npm run postinstall` (`scripts/check-native.js`) reports
  the native shell's presence but does not compile it.
- **Two physical Android devices** for discovery, consent, connect, message, disconnect and
  reconnect, plus an offline run with mobile data and Wi-Fi infrastructure off.
- **Device capability matrix** — this is a hardware property, not something code can assert:

| Transport | Requires | Notes |
| --- | --- | --- |
| Wi-Fi Aware (NAN) | Android 8.0+, chipset support, both devices | Preferred route; absent on many budget models |
| Wi-Fi Direct | Android 4.0+, near-universal | Fallback; works without a router |
| Bluetooth LE | Android 4.3+ | Discovery and small frames |
| LoRa | external gateway hardware | Optional, opt-in, never required |

Tecno, Infinix and Itel devices vary by model and Android version; the app asks the device
what it supports and routes accordingly rather than assuming.

Permission behaviour is implemented (discovery starts only after an explicit grant, relay
participation is opt-in and revocable, no radio settings are changed silently) but the
permission dialogs themselves have not been exercised on a device.

---

## 5. How to close this stage

1. Install the Android SDK and run `npx cap sync android`, then build a debug APK.
2. Install on two supported phones on the same table, grant nearby permissions.
3. With mobile data and Wi-Fi infrastructure off, send a message and a post between them;
   confirm the status reads "Sent via #ash Nearby" and the frame appears once.
4. Walk out of range, confirm the item is held ("Saved Offline — Will Send Automatically"),
   walk back, confirm it delivers without duplication.
5. Repeat with Wi-Fi Aware disabled to force Wi-Fi Direct, then with both disabled for BLE.
6. Record the result per device model in this document.

Until step 6 exists, treat nearby networking as **implemented and contract-verified, not
device-verified**.
