package com.ashmesh.app;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.ParcelUuid;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Bluetooth LE transport — discovery and coordination for Layer 3, and the low-power route for
 * small messages when Wi-Fi Direct/NAN are unavailable or the battery is below 20%.
 *
 * Peers are advertised by service UUID; small control frames travel in the advertisement and in
 * GATT writes. Larger payloads are handed to Wi-Fi Direct by the routing engine.
 *
 * NOTE: native source only. Not compiled or device-tested in this environment — see native/README.md.
 */
public class NearbyBle {

    public interface PeerSink { void onPeer(String id, String name, String transport); }
    public interface PayloadSink { void onPayload(String peerId, String json); }

    private static final String TAG = "AshMeshBle";
    public static final UUID SERVICE_UUID = UUID.fromString("6a73686d-2d6d-6573-682d-6e6561726279");
    public static final UUID RX_CHAR_UUID = UUID.fromString("6a73686d-2d6d-6573-682d-727800000001");
    public static final UUID TX_CHAR_UUID = UUID.fromString("6a73686d-2d6d-6573-682d-747800000001");

    private final Context context;
    private final PeerSink peerSink;
    private final PayloadSink payloadSink;
    private final Map<String, BluetoothDevice> devices = new ConcurrentHashMap<>();

    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattServer gattServer;
    private volatile boolean running = false;

    public NearbyBle(Context context, PeerSink peerSink, PayloadSink payloadSink) {
        this.context = context;
        this.peerSink = peerSink;
        this.payloadSink = payloadSink;
    }

    public void start() {
        BluetoothManager bm = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm == null) {
            Log.i(TAG, "no Bluetooth hardware");
            return;
        }
        BluetoothAdapter adapter = bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            Log.i(TAG, "Bluetooth off or unavailable");
            return;
        }
        if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            Log.i(TAG, "BLE not supported");
            return;
        }

        running = true;
        startServer(bm, adapter);
        startScan(adapter);
        startAdvertising(adapter);
    }

    // ---------------------------------------------------------------- GATT server (receive)

    private void startServer(BluetoothManager bm, BluetoothAdapter adapter) {
        try {
            gattServer = bm.openGattServer(context, new BluetoothGattServerCallback() {
                @Override
                public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                                                        BluetoothGattCharacteristic characteristic,
                                                        boolean preparedWrite, boolean responseNeeded,
                                                        int offset, byte[] value) {
                    if (RX_CHAR_UUID.equals(characteristic.getUuid()) && value != null) {
                        payloadSink.onPayload(device.getAddress(), new String(value, StandardCharsets.UTF_8));
                    }
                    if (responseNeeded && gattServer != null) {
                        gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null);
                    }
                }

                @Override
                public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                    if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                        devices.put(device.getAddress(), device);
                        peerSink.onPeer(device.getAddress(), device.getName(), "ble");
                    }
                }
            });

            BluetoothGattService service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            BluetoothGattCharacteristic rx = new BluetoothGattCharacteristic(
                RX_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE);
            service.addCharacteristic(rx);
            gattServer.addService(service);
        } catch (SecurityException e) {
            Log.w(TAG, "BLE permissions missing for GATT server", e);
        }
    }

    // ---------------------------------------------------------------- scan (discover)

    private void startScan(BluetoothAdapter adapter) {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;

        List<ScanFilter> filters = Collections.singletonList(
            new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
            .build();

        try {
            scanner.startScan(filters, settings, new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    BluetoothDevice device = result.getDevice();
                    if (device == null) return;
                    devices.put(device.getAddress(), device);
                    peerSink.onPeer(device.getAddress(), device.getName(), "ble");
                }

                @Override
                public void onScanFailed(int errorCode) {
                    Log.w(TAG, "BLE scan failed: " + errorCode);
                }
            });
        } catch (SecurityException e) {
            Log.w(TAG, "BLE scan permission denied", e);
        }
    }

    // ---------------------------------------------------------------- advertise (be found)

    private void startAdvertising(BluetoothAdapter adapter) {
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) return;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .addServiceUuid(new ParcelUuid(SERVICE_UUID))
            .setIncludeDeviceName(false)
            .build();
        try {
            advertiser.startAdvertising(settings, data, new AdvertiseCallback() {
                @Override public void onStartSuccess(AdvertiseSettings s) { Log.i(TAG, "advertising #ash Mesh"); }
                @Override public void onStartFailure(int errorCode) { Log.w(TAG, "advertise failed: " + errorCode); }
            });
        } catch (SecurityException e) {
            Log.w(TAG, "BLE advertise permission denied", e);
        }
    }

    // ---------------------------------------------------------------- send

    /** Writes an encrypted frame to a connected peer's RX characteristic. */
    public boolean send(String peerId, byte[] payload) {
        if (payload.length > 512) {
            // Too large for a GATT write: the routing engine should use Wi-Fi Direct instead.
            return false;
        }
        BluetoothDevice device = devices.get(peerId);
        if (device == null || gattServer == null) return false;
        try {
            BluetoothGattService service = gattServer.getService(SERVICE_UUID);
            if (service == null) return false;
            BluetoothGattCharacteristic rx = service.getCharacteristic(RX_CHAR_UUID);
            if (rx == null) return false;
            rx.setValue(payload);
            return gattServer.notifyCharacteristicChanged(device, rx, false);
        } catch (SecurityException e) {
            Log.w(TAG, "BLE send permission denied", e);
            return false;
        }
    }

    public void stop() {
        running = false;
        try {
            if (scanner != null) scanner.stopScan(null);
            if (advertiser != null) advertiser.stopAdvertising(null);
            if (gattServer != null) gattServer.close();
        } catch (Exception e) {
            Log.w(TAG, "error closing BLE transport", e);
        }
        devices.clear();
    }
}
