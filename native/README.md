# Native Android bridge

The web app cannot open Wi-Fi Aware, Wi-Fi Direct or background Bluetooth sockets. Everything a
browser cannot do lives here, behind one Capacitor plugin, and the web client detects it honestly:

```js
// client/src/uar.js
const bridge = globalThis.AshMeshNative;
if (bridge) { const caps = await bridge.getCapabilities(); /* … */ }
```

If the bridge is missing, `platform` stays `'web'`, the UAR engine uses internet + the encrypted
offline queue, and the UI says *"Offline radio routing requires the #ash Mesh Android app"*. It
never claims a radio it does not have.

## Files

| File | Purpose |
| --- | --- |
| `capacitor.config.json` | appId `com.ashmesh.app`, webDir `../client/dist` |
| `android/app/src/main/java/com/ashmesh/app/MainActivity.java` | registers the plugin |
| `…/AshMeshNativePlugin.java` | capability probes, peer registry, send, relay consent |
| `…/NearbyAware.java` | Wi-Fi Aware (NAN) publish/subscribe + message frames |
| `…/NearbyDirect.java` | Wi-Fi Direct discovery + length-prefixed socket transfer |
| `…/NearbyBle.java` | BLE advertise/scan + GATT write for small frames |
| `android/app/src/main/AndroidManifest.xml` | scoped nearby + media permissions |

## Bridge contract

```ts
getCapabilities(): Promise<{
  wifiAware: boolean; wifiDirect: boolean; ble: boolean; lora: boolean;
  platform: 'native'; sdk: number; relayConsent: boolean;
}>
requestNearbyPermissions(): Promise<{ nearbyWifi: boolean; bluetooth: boolean }>
startNearby(): Promise<void>
stopNearby(): Promise<void>
getPeers(): Promise<{ peers: { id: string; name: string; transport: string; lastSeen: number }[] }>
sendNearby(opts: { peerId: string; payload: string; transport?: 'auto'|'wifiAware'|'wifiDirect'|'ble' }):
  Promise<{ ok: boolean; transport: string; bytes: number; reason?: string }>
setRelayConsent(opts: { enabled: boolean }): Promise<{ relayConsent: boolean }>

// events
addListener('peers', cb)          // peer list changed
addListener('nearbyMessage', cb)  // { peerId, payload } — payload is still encrypted
```

`payload` is always the client-side encrypted envelope. The plugin treats it as opaque bytes and
never holds a decryption key.

## Routing rules implemented here

* Small frames (≤512 bytes) prefer BLE — lowest power.
* Anything larger goes to Wi-Fi Direct, which has the bandwidth for video and 3D assets.
* Wi-Fi Aware is preferred when available because it needs no SIM, no router and no pairing.
* If a transport fails, the plugin reports `ok: false` and the web client queues the message
  instead of losing it.
* Battery below 20%: the web client stops initiating high-power transfers before calling the
  plugin (see `lowPower()` in `client/src/uar.js`).

## Building the APK

Android Studio with SDK 34 is required. These steps have **not** been run in this environment
(no Android SDK, no device), so treat the native code as unverified until you build it.

```bash
npm run build --prefix ..            # produce client/dist first
cd native
npm install
npx cap add android                  # creates the Gradle project if absent
npx cap sync android
# copy the Java sources in android/app/src/main/java/com/ashmesh/app/ if cap add overwrote them
npx cap open android                 # build/run from Android Studio
```

Gradle dependencies: `com.getcapacitor:capacitor-android:6.x` (added by `cap add android`).

## Device testing checklist

1. Two Android 8+ phones with Wi-Fi Aware → both show *Wi-Fi Aware available* in Network.
2. Turn off mobile data and Wi-Fi on both, enable #ash Nearby → peers appear.
3. Send a text message → status reads *Sent via #ash Nearby*.
4. Send a 5 MB video → routes over Wi-Fi Direct, arrives intact.
5. Disable both radios → message is saved offline, then sends automatically when a route returns.
6. Revoke relay consent → the radio stack stops immediately, no background scanning continues.
7. Repeat on a BLE-only device → falls back to BLE for small messages.

## Honest limitations

* NAN peer ids are session-scoped; a stable identity handshake belongs in the encrypted layer.
* `NearbyDirect` assumes the group owner listens on `192.168.49.1:8988`; a production build should
  read the real group-owner address from `WifiP2pInfo`.
* Wi-Fi Direct group formation is started by the OS dialog, not silently.
* No background service yet: discovery stops when the app is backgrounded.
* LoRa is not implemented — the capability flag is only true after a gateway is paired, and no
  gateway driver ships here.
