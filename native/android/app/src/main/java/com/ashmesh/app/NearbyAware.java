package com.ashmesh.app;

import android.content.Context;
import android.net.wifi.aware.AttachCallback;
import android.net.wifi.aware.DiscoverySessionCallback;
import android.net.wifi.aware.PeerHandle;
import android.net.wifi.aware.PublishConfig;
import android.net.wifi.aware.PublishDiscoverySession;
import android.net.wifi.aware.SubscribeConfig;
import android.net.wifi.aware.SubscribeDiscoverySession;
import android.net.wifi.aware.WifiAwareManager;
import android.net.wifi.aware.WifiAwareSession;
import android.os.Build;
import android.util.Log;

import androidx.annotation.RequiresApi;

import java.util.HashMap;
import java.util.Map;

/**
 * Wi-Fi Aware (NAN) transport — Layer 2 of Universal Adaptive Routing.
 *
 * Nearby communication with no SIM, no router and no internet: devices publish/subscribe to the
 * "_ashmesh._tcp" service and exchange opaque encrypted frames. Requires API 26+ and hardware
 * that reports FEATURE_WIFI_AWARE; otherwise the stack is simply not started.
 *
 * NOTE: this file is native source only. It cannot be compiled or exercised in this environment
 * (no Android SDK/device), so its runtime behaviour is unverified — see native/README.md.
 */
@RequiresApi(api = Build.VERSION_CODES.O)
public class NearbyAware {

    public interface PeerSink { void onPeer(String id, String name, String transport); }
    public interface PayloadSink { void onPayload(String peerId, String json); }

    private static final String TAG = "AshMeshAware";
    private static final String SERVICE = "_ashmesh._tcp";

    private final Context context;
    private final PeerSink peerSink;
    private final PayloadSink payloadSink;

    private WifiAwareManager manager;
    private WifiAwareSession session;
    private PublishDiscoverySession publishSession;
    private SubscribeDiscoverySession subscribeSession;

    /** peerId -> NAN peer handle, needed to address a data path. */
    private final Map<String, PeerHandle> handles = new HashMap<>();
    private final Map<String, String> peerNames = new HashMap<>();

    public NearbyAware(Context context, PeerSink peerSink, PayloadSink payloadSink) {
        this.context = context;
        this.peerSink = peerSink;
        this.payloadSink = payloadSink;
    }

    public void start() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        manager = (WifiAwareManager) context.getSystemService(Context.WIFI_AWARE_SERVICE);
        if (manager == null || !manager.isAvailable()) {
            Log.i(TAG, "Wi-Fi Aware unavailable on this device");
            return;
        }
        manager.attach(new AttachCallback() {
            @Override
            public void onAttached(WifiAwareSession s) {
                session = s;
                publish();
                subscribe();
            }

            @Override
            public void onAttachFailed() {
                Log.w(TAG, "Wi-Fi Aware attach failed (radio off or in use)");
            }
        }, null, context.getMainExecutor());
    }

    private void publish() {
        if (session == null) return;
        PublishConfig config = new PublishConfig.Builder()
            .setServiceName(SERVICE)
            .build();
        session.publish(config, new DiscoverySessionCallback() {
            @Override
            public void onPublishStarted(PublishDiscoverySession s) {
                publishSession = s;
            }

            @Override
            public void onMessageReceived(PeerHandle peer, byte[] message) {
                handleIncoming(peer, message);
            }
        }, null);
    }

    private void subscribe() {
        if (session == null) return;
        SubscribeConfig config = new SubscribeConfig.Builder()
            .setServiceName(SERVICE)
            .build();
        session.subscribe(config, new DiscoverySessionCallback() {
            @Override
            public void onSubscribeStarted(SubscribeDiscoverySession s) {
                subscribeSession = s;
            }

            @Override
            public void onServiceDiscovered(PeerHandle peer, byte[] serviceSpecificInfo, java.util.List<byte[]> matchFilter) {
                String id = peerId(peer);
                String name = serviceSpecificInfo == null ? "" : new String(serviceSpecificInfo);
                handles.put(id, peer);
                peerNames.put(id, name);
                peerSink.onPeer(id, name, "wifiAware");
            }

            @Override
            public void onMessageReceived(PeerHandle peer, byte[] message) {
                handleIncoming(peer, message);
            }
        }, null);
    }

    private void handleIncoming(PeerHandle peer, byte[] message) {
        String id = peerId(peer);
        String json = new String(message);
        payloadSink.onPayload(id, json);
    }

    /** NAN peer handles are not stable identifiers; derive a session-scoped id from the handle. */
    private String peerId(PeerHandle handle) {
        return "nan-" + Integer.toHexString(System.identityHashCode(handle));
    }

    public boolean send(String peerId, byte[] payload) {
        PeerHandle handle = handles.get(peerId);
        if (handle == null) return false;
        try {
            if (publishSession != null) {
                publishSession.sendMessage(handle, payload, 0, 0);
                return true;
            }
            if (subscribeSession != null) {
                subscribeSession.sendMessage(handle, payload, 0, 0);
                return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "NAN send failed", e);
        }
        return false;
    }

    public void stop() {
        try {
            if (publishSession != null) publishSession.close();
            if (subscribeSession != null) subscribeSession.close();
            if (session != null) session.close();
        } catch (Exception e) {
            Log.w(TAG, "error closing NAN sessions", e);
        }
        publishSession = null;
        subscribeSession = null;
        session = null;
        handles.clear();
    }
}
