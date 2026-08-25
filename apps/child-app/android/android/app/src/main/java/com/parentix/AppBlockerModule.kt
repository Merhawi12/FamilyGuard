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

        /**
         * Apps the parent marked "keep open when the daily limit is reached".
         *
         * Read only while `blockedPackages` holds the `"*"` wildcard, and the RN
         * layer only sends a non-empty set when the lock is the `daily_limit`
         * one — bedtime, an out-of-hours schedule and a parent's own pause arrive
         * with this cleared. The tier decision stays in one place (schedule.js)
         * and this side just enforces what it was handed.
         *
         * Persisted alongside the block list because the two are one decision. A
         * service restored from disk with its blocks but not its exceptions would
         * come back stricter than the parent set it, which is the direction that
         * strands a child mid-homework with no explanation.
         */
        val allowedPackages = mutableSetOf<String>()

        private const val PREFS = "px_blocking"
        private const val KEY_APPS = "blocked_apps"
        private const val KEY_ALLOWED = "allowed_apps"

        private var reactContext: ReactApplicationContext? = null
        private var lastBlockedPkg: String? = null
        private var lastBlockedAt: Long = 0L

        // Persist the current block list so the accessibility service can restore
        // it after the process is killed and restarted without the RN layer running.
        fun persist(ctx: Context) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putStringSet(KEY_APPS, HashSet(blockedPackages))
                .putStringSet(KEY_ALLOWED, HashSet(allowedPackages))
                .apply()
        }

        // Reload the persisted lists into memory (called on service connect/boot).
        fun loadPersisted(ctx: Context) {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val saved = prefs.getStringSet(KEY_APPS, emptySet()) ?: emptySet()
            blockedPackages.clear()
            blockedPackages.addAll(saved)

            val allowed = prefs.getStringSet(KEY_ALLOWED, emptySet()) ?: emptySet()
            allowedPackages.clear()
            allowedPackages.addAll(allowed)
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

    /**
     * The apps that survive a `daily_limit` lock.
     *
     * Lower-cased on the way in, because a package name is matched
     * case-insensitively against what the accessibility service reports and a
     * parent typing `Com.Microsoft.Office.Word` into the rule form must not end up
     * with an exception that never fires.
     */
    @ReactMethod
    fun setAllowedApps(packages: ReadableArray) {
        allowedPackages.clear()
        for (i in 0 until packages.size()) {
            packages.getString(i)?.let { allowedPackages.add(it.lowercase()) }
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

    /**
     * The packages this device will never block, whatever any rule says.
     *
     * Exposed to JS so the child's Settings screen can show the child what stays
     * open during a lock, and so the harness can assert on it. Resolving it needs
     * a context, which is why it is not simply a constant in JS.
     */
    @ReactMethod
    fun getAlwaysAllowedApps(promise: Promise) {
        val result = Arguments.createArray()
        for (pkg in AppMonitorService.alwaysAllowed(ctx)) result.pushString(pkg)
        promise.resolve(result)
    }

    // Required by RN's NativeEventEmitter (no-ops — we emit unconditionally).
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Double) {}
}
