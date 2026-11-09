# Offline-first architecture

#ash Mesh is one application with two operating modes. It does not ask the user to pick a
mode; it uses whatever route is available and keeps a single, consistent dataset.

```
Internet available   ->  global mode  (Supabase-backed API, realtime social graph)
No internet          ->  local mode   (IndexedDB, full read access + queued writes)
Nearby radios        ->  mesh mode    (native Wi-Fi Aware / Direct / BLE peer transfer)
Reconnect            ->  reconcile    (outbox replay + cursor pull + conflict resolution)
```

## Client data layer

`client/src/localdb.js` is a small IndexedDB wrapper with one object store per collection:
profile, feed, threads, messages, academy, heritage, marketplace, media blobs, outbox and a
cursor record. Everything the user can read offline is cached here; nothing is thrown away
when the tab closes.

`client/src/sync.js` owns the lifecycle:

| Concern | Implementation |
| --- | --- |
| Queued writes | `enqueue()` writes the operation with a `clientId` before the network call |
| Replay | `flushOutbox()` posts each item, removes it only after server acceptance |
| Idempotency | server stores `client_id` on posts and returns the existing row on replay |
| Conflicts | `pickNewer()` = last-writer-wins on `updatedAt`; a tombstone always beats a live row |
| Pull | `pullChanges()` uses an ISO cursor, `>=` comparison so same-millisecond writes are never skipped |
| Triggers | `startAutoSync()` on `online`, window focus, tab visible, and a 60 s timer |

Private message bodies are stored offline as E2E envelopes (`client/src/crypto.js`), so the
local database holds ciphertext for message content, not plaintext.

## Server sync API

`server/routes-sync.js`

* `GET /api/sync/pull?since=<iso>` — posts (filtered through the same visibility rules as the
  feed, so sync can never reveal a post the viewer may not see), own deletion tombstones,
  threads, academy, heritage, marketplace, and a new cursor.
* `POST /api/sync/push` — batch replay of up to 50 operations (`post`, `comment`, `like`).
  Each result is `accepted`, `duplicate` or `rejected` with a reason. Messages are excluded
  on purpose: they travel through `/api/conversations/:id/messages` because they carry
  encryption envelopes.

Both endpoints require an authenticated session, are rate limited, and push is CSRF protected.

## Nearby transport

`client/src/nearby.js` is the client half of the native bridge. The Android shell lives in
`native/android/app/src/main/java/com/ashmesh/app/` (`AshMeshNativePlugin`, `NearbyAware`,
`NearbyDirect`, `NearbyBle`) and is registered by `MainActivity`.

Bridge contract expected by the web client:

```js
AshMeshNative.capabilities()            // { aware, direct, ble, lora }
AshMeshNative.startDiscovery()          // begin scanning
AshMeshNative.stopDiscovery()
AshMeshNative.peers()                   // [{ id, name, transport, rssi }]
AshMeshNative.send({ peerId, payload }) // UTF-8 JSON frame
// inbound frames are dispatched as  window.dispatchEvent(
//   new CustomEvent('ashmesh:nearby-frame', { detail: frameJson }))
```

Frames are `{ v, id, type, hops, createdAt, item }`, de-duplicated by `id`, forwarded at most
three hops, and persisted in a relay queue (`localStorage: ashmesh.relay.v1`) when no peer is
reachable. A device that has internet and has opted in (`setRelayConsent(true)`) replays a
received item against the server. Relays only ever forward ciphertext for private messages.

In a plain browser `capabilities()` reports `native: false` and the UI states that nearby
networking needs the Android build. No browser feature is simulated.

## What is verified, and what is not

| Area | Status |
| --- | --- |
| Outbox replay, idempotency, rejected-operation handling | Verified by `npm test` (API level) |
| Pull cursors, private-post isolation, tombstones | Verified by `npm test` |
| Academy / Heritage CRUD, enrolment, progress, offline bundles | Verified by `npm test` |
| Offline caching and queueing in the UI | Implemented; verified by build + browser smoke check |
| Native Wi-Fi Aware / Direct / BLE transfer | Implemented in the Android shell; **not** verified — requires physical Android hardware with the radios, and native builds are outside what this environment can compile or run |
| Relay store-and-forward between two devices | Implemented; not verified without two devices |
| LoRa gateway | Optional, requires external hardware |

Honest summary: the online path and the offline queue/sync path are exercised by automated
tests. The radio path is real code against real Android APIs, but only a device test can
prove it works, so it is not claimed as tested.
