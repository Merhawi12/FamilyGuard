package com.parentix

import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class AppBlockerModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    init { reactContext = ctx }

    override fun getName() = "AppBlocker"

    companion object {
        val blockedPackages = mutableSetOf<String>()

        private const val PREFS = "px_blocking"
        private const val KEY_APPS = "blocked_apps"

        private var reactContext: ReactApplicationContext? = null
        private var lastBlockedPkg: String? = null
        private var lastBlockedAt: Long = 0L

        // Persist the current block list so the accessibility service can restore
        // it after the process is killed and restarted without the RN layer running.
        fun persist(ctx: Context) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putStringSet(KEY_APPS, HashSet(blockedPackages))
                .apply()
        }

        // Reload the persisted block list into memory (called on service connect/boot).
        fun loadPersisted(ctx: Context) {
            val saved = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getStringSet(KEY_APPS, emptySet()) ?: emptySet()
            blockedPackages.clear()
            blockedPackages.addAll(saved)
        }

        // Emit a JS "onAppBlocked" event when a blocked app is opened. Throttled so a
        // child repeatedly reopening the same app doesn't spam the parent with alerts.
        fun notifyBlocked(packageName: String) {
            val now = System.currentTimeMillis()
            if (packageName == lastBlockedPkg && now - lastBlockedAt < 60_000L) return
            lastBlockedPkg = packageName
            lastBlockedAt = now

            val ctx = reactContext ?: return
            if (!ctx.hasActiveReactInstance()) return
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onAppBlocked", packageName)
        }
    }

    @ReactMethod
    fun setBlockedApps(packages: ReadableArray) {
        blockedPackages.clear()
        for (i in 0 until packages.size()) {
            packages.getString(i)?.let { blockedPackages.add(it) }
        }
        persist(ctx)
    }

    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        val enabledServices = Settings.Secure.getString(
            ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: ""
        val componentName = "${ctx.packageName}/com.parentix.AppMonitorService"
        val enabled = enabledServices.split(":").any { it.equals(componentName, ignoreCase = true) }
        promise.resolve(enabled)
    }

    @ReactMethod
    fun openSettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        ctx.startActivity(intent)
    }

    // Required by RN's NativeEventEmitter (no-ops — we emit unconditionally).
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Double) {}
}
