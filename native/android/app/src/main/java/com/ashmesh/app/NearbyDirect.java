package com.ashmesh.app;

import android.content.Context;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pManager;
import android.util.Log;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/**
 * Wi-Fi Direct transport — Layer 3 of Universal Adaptive Routing.
 *
 * Used for larger payloads (video, 3D models, voice notes) where BLE and NAN are too slow.
 * Frames are length-prefixed and carry an already-encrypted envelope; this class never sees
 * plaintext message content.
 *
 * NOTE: native source only. It is not compiled or device-tested in this environment, so runtime
 * behaviour is unverified — see native/README.md.
 */
public class NearbyDirect {

    public interface PeerSink { void onPeer(String id, String name, String transport); }
    public interface PayloadSink { void onPayload(String peerId, String json); }

    private static final String TAG = "AshMeshDirect";
    private static final int PORT = 8988;
    private static final int MAX_FRAME = 8 * 1024 * 1024;

    private final Context context;
    private final PeerSink peerSink;
    private final PayloadSink payloadSink;
    private final Map<String, WifiP2pDevice> devices = new ConcurrentHashMap<>();
    private final Map<String, Socket> sockets = new ConcurrentHashMap<>();

    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private ServerSocket server;
    private Thread serverThread;
    private volatile boolean running = false;

    public NearbyDirect(Context context, PeerSink peerSink, PayloadSink payloadSink) {
        this.context = context;
        this.peerSink = peerSink;
        this.payloadSink = payloadSink;
    }

    public void start() {
        if (!context.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_WIFI_DIRECT)) {
            Log.i(TAG, "Wi-Fi Direct not supported on this device");
            return;
        }
        manager = (WifiP2pManager) context.getSystemService(Context.WIFI_P2P_SERVICE);
        if (manager == null) return;
        channel = manager.initialize(context, context.getMainLooper(), null);
        running = true;
        startServer();
        discover();
    }

    private void discover() {
        try {
            manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { Log.i(TAG, "peer discovery started"); }
                @Override public void onFailure(int reason) { Log.w(TAG, "peer discovery failed: " + reason); }
            });
        } catch (SecurityException e) {
            Log.w(TAG, "missing nearby Wi-Fi permission", e);
        }
    }

    /** Called by the host activity when the P2P broadcast receiver sees a device list. */
    public void onPeersAvailable(java.util.Collection<WifiP2pDevice> peerList) {
        for (WifiP2pDevice d : peerList) {
            devices.put(d.deviceAddress, d);
            peerSink.onPeer(d.deviceAddress, d.deviceName, "wifiDirect");
        }
    }

    private void startServer() {
        serverThread = new Thread(() -> {
            try {
                server = new ServerSocket(PORT);
                while (running) {
                    Socket socket = server.accept();
                    Executors.newSingleThreadExecutor().submit(() -> readLoop(socket));
                }
            } catch (Exception e) {
                if (running) Log.w(TAG, "server socket stopped", e);
            }
        }, "ashmesh-direct-server");
        serverThread.setDaemon(true);
        serverThread.start();
    }

    private void readLoop(Socket socket) {
        try (DataInputStream in = new DataInputStream(socket.getInputStream())) {
            String peerId = in.readUTF();
            sockets.put(peerId, socket);
            while (running && !socket.isClosed()) {
                int len = in.readInt();
                if (len <= 0 || len > MAX_FRAME) break;
                byte[] buf = new byte[len];
                in.readFully(buf);
                payloadSink.onPayload(peerId, new String(buf, StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.i(TAG, "direct link closed");
        }
    }

    public boolean send(String peerId, byte[] payload) {
        if (payload.length > MAX_FRAME) return false;
        Socket socket = sockets.get(peerId);
        if (socket == null || socket.isClosed()) {
            socket = connect(peerId);
            if (socket == null) return false;
            sockets.put(peerId, socket);
        }
        try {
            DataOutputStream out = new DataOutputStream(socket.getOutputStream());
            out.writeUTF(localId());
            out.writeInt(payload.length);
            out.write(payload);
            out.flush();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "direct send failed", e);
            sockets.remove(peerId);
            return false;
        }
    }

    private Socket connect(String peerId) {
        WifiP2pDevice device = devices.get(peerId);
        if (device == null) return null;
        try {
            // The group owner listens; a connected client dials the group owner's address.
            Socket socket = new Socket();
            socket.connect(new java.net.InetSocketAddress(java.net.InetAddress.getByName("192.168.49.1"), PORT), 5000);
            return socket;
        } catch (Exception e) {
            Log.w(TAG, "could not open direct socket to " + peerId, e);
            return null;
        }
    }

    private String localId() {
        return android.provider.Settings.Secure.getString(context.getContentResolver(), "android_id");
    }

    public void stop() {
        running = false;
        try {
            if (server != null) server.close();
            for (Socket s : sockets.values()) {
                try { s.close(); } catch (Exception ignored) { }
            }
        } catch (Exception e) {
            Log.w(TAG, "error closing direct transport", e);
        }
        sockets.clear();
        devices.clear();
        if (manager != null && channel != null) {
            try { manager.stopPeerDiscovery(channel, null); } catch (Exception ignored) { }
        }
    }
}
