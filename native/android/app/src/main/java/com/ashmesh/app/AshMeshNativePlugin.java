package com.ashmesh.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.wifi.aware.WifiAwareManager;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AshMeshNative — the only bridge between the web app and radios a browser cannot reach.
 *
 * Contract used by client/src/uar.js:
 *   getCapabilities() -> { wifiAware, wifiDirect, ble, lora, platform, sdk }
 *   startNearby() / stopNearby() / getPeers() / sendNearby({ peerId, payload, transport })
 *   setRelayConsent({ enabled })
 * Events: "peers" (peer list changed) and "nearbyMessage" (payload received from a peer).
 *
 * Honesty rules baked in: every capability is probed on the real device. If the hardware or the
 * OS version does not support Wi-Fi Aware, wifiAware is false and the UAR engine falls back to
 * Wi-Fi Direct, then BLE, then the encrypted offline queue. Nothing is faked.
 */
@CapacitorPlugin(
    name = "AshMeshNative",
    permissions = {
        @Permission(alias = "nearbyWifi", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT
        })
    }
)
public class AshMeshNativePlugin extends Plugin {

    private static final String TAG = "AshMeshNative";
    private static final String PREFS = "ashmesh-native";
    private static final String KEY_RELAY = "relayConsent";

    private final Map<String, Peer> peers = new LinkedHashMap<>();

    private NearbyAware aware;
    private NearbyDirect direct;
    private NearbyBle ble;
    private boolean running = false;

    public static class Peer {
        public final String id;
        public String name;
        public String transport;
        public long lastSeen;

        Peer(String id, String name, String transport) {
            this.id = id;
            this.name = name;
            this.transport = transport;
            this.lastSeen = System.currentTimeMillis();
        }

        JSObject toJson() {
            JSObject o = new JSObject();
            o.put("id", id);
            o.put("name", name == null ? "" : name);
            o.put("transport", transport);
            o.put("lastSeen", lastSeen);
            return o;
        }
    }

    // ------------------------------------------------------------------ capabilities

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        Context ctx = getContext();
        boolean awareSupported = false;
        boolean directSupported = false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WifiAwareManager wam = (WifiAwareManager) ctx.getSystemService(Context.WIFI_AWARE_SERVICE);
            awareSupported = wam != null && wam.isAvailable();
        }
        if (ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) {
            directSupported = true;
        }

        boolean bleSupported = ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE);
        // LoRa needs an external gateway; only reported when one was paired by the user.
        boolean loraSupported = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean("loraGatewayPaired", false);

        JSObject caps = new JSObject();
        caps.put("wifiAware", awareSupported && hasNearbyWifiPermission());
        caps.put("wifiDirect", directSupported);
        caps.put("ble", bleSupported && hasBluetoothPermission());
        caps.put("lora", loraSupported);
        caps.put("platform", "native");
        caps.put("sdk", Build.VERSION.SDK_INT);
        caps.put("relayConsent", relayConsentEnabled());
        call.resolve(caps);
    }

    private boolean hasNearbyWifiPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBluetoothPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_SCAN)
                    == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_ADVERTISE)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    // ------------------------------------------------------------------ lifecycle

    @PluginMethod
    public void requestNearbyPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissionForAliases(new String[] { "nearbyWifi", "bluetooth" }, call, "onPermissions");
        } else {
            requestPermissionForAlias("nearbyWifi", call, "onPermissions");
        }
    }

    @PermissionCallback
    private void onPermissions(PluginCall call) {
        JSObject res = new JSObject();
        res.put("nearbyWifi", hasNearbyWifiPermission());
        res.put("bluetooth", hasBluetoothPermission());
        call.resolve(res);
    }

    @PluginMethod
    public void startNearby(PluginCall call) {
        if (running) {
            call.resolve();
            return;
        }
        Context ctx = getContext();
        aware = new NearbyAware(ctx, this::onPeer, this::onPayload);
        direct = new NearbyDirect(ctx, this::onPeer, this::onPayload);
        ble = new NearbyBle(ctx, this::onPeer, this::onPayload);

        if (hasNearbyWifiPermission()) aware.start();
        direct.start();
        if (hasBluetoothPermission()) ble.start();

        running = true;
        Log.i(TAG, "nearby stack started");
        call.resolve();
    }

    @PluginMethod
    public void stopNearby(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    private void stopInternal() {
        if (aware != null) aware.stop();
        if (direct != null) direct.stop();
        if (ble != null) ble.stop();
        running = false;
        peers.clear();
        notifyPeers();
    }

    @PluginMethod
    public void getPeers(PluginCall call) {
        JSArray arr = new JSArray();
        long cutoff = System.currentTimeMillis() - 120_000L;
        for (Peer p : peers.values()) {
            if (p.lastSeen >= cutoff) arr.put(p.toJson());
        }
        JSObject res = new JSObject();
        res.put("peers", arr);
        call.resolve(res);
    }

    /**
     * Sends an already-encrypted payload to a nearby peer. The plugin never inspects or decrypts
     * the envelope: it is opaque bytes produced by the web client's E2E layer.
     */
    @PluginMethod
    public void sendNearby(PluginCall call) {
        String peerId = call.getString("peerId");
        String payload = call.getString("payload");
        String transport = call.getString("transport", "auto");

        if (peerId == null || payload == null) {
            call.reject("peerId and payload are required");
            return;
        }
        byte[] bytes = payload.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Peer peer = peers.get(peerId);
        String chosen = peer == null ? transport : peer.transport;

        boolean ok;
        if ("ble".equals(chosen)) {
            ok = ble != null && ble.send(peerId, bytes);
        } else if ("wifiDirect".equals(chosen) || bytes.length > 512) {
            ok = direct != null && direct.send(peerId, bytes);
            if (!ok && ble != null) ok = ble.send(peerId, bytes);
        } else {
            ok = aware != null && aware.send(peerId, bytes);
            if (!ok && direct != null) ok = direct.send(peerId, bytes);
            if (!ok && ble != null) ok = ble.send(peerId, bytes);
        }

        JSObject res = new JSObject();
        res.put("ok", ok);
        res.put("transport", chosen);
        res.put("bytes", bytes.length);
        if (!ok) res.put("reason", "no_reachable_peer");
        call.resolve(res);
    }

    @PluginMethod
    public void setRelayConsent(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_RELAY, enabled).apply();
        if (!enabled) {
            // Revoking consent immediately stops relaying for others and drops the radio stack.
            stopInternal();
        }
        JSObject res = new JSObject();
        res.put("relayConsent", enabled);
        call.resolve(res);
    }

    private boolean relayConsentEnabled() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_RELAY, false);
    }

    // ------------------------------------------------------------------ callbacks

    private void onPeer(String id, String name, String transport) {
        Peer peer = peers.get(id);
        if (peer == null) {
            peer = new Peer(id, name, transport);
            peers.put(id, peer);
        } else {
            peer.name = name != null ? name : peer.name;
            peer.transport = transport;
            peer.lastSeen = System.currentTimeMillis();
        }
        notifyPeers();
    }

    private void onPayload(String fromPeerId, String json) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("peerId", fromPeerId);
            obj.put("payload", json);
            notifyListeners("nearbyMessage", JSObject.fromJSONObject(obj));
        } catch (JSONException e) {
            Log.w(TAG, "dropping malformed nearby payload", e);
        }
    }

    private void notifyPeers() {
        JSArray arr = new JSArray();
        for (Peer p : peers.values()) arr.put(p.toJson());
        JSObject res = new JSObject();
        res.put("peers", arr);
        notifyListeners("peers", res);
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }
}
