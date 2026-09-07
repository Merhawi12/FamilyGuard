package ca.parentix.family;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * Plugins that ship as npm packages are discovered from
     * `assets/capacitor.plugins.json`, which `npx cap sync` writes. This one is
     * first-party source inside this project, so nothing generates an entry for
     * it and it is registered by hand — before `super.onCreate`, which is where
     * the bridge is built and the registry is read.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GoogleAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
