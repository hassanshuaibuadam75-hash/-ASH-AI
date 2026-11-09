package com.ashmesh.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * #ash Mesh Android entry point.
 *
 * The web app (client/) runs unchanged inside the Capacitor WebView. Everything the browser
 * cannot do — Wi-Fi Aware (NAN), Wi-Fi Direct, Bluetooth LE and the encrypted offline store —
 * is exposed through the AshMeshNative plugin registered below. The web client detects it via
 * globalThis.AshMeshNative and never pretends those radios exist in a plain browser.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AshMeshNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
