package com.familyguard

import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.*

class AppBlockerModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "AppBlocker"

    companion object {
        val blockedPackages = mutableSetOf<String>()
    }

    @ReactMethod
    fun setBlockedApps(packages: ReadableArray) {
        blockedPackages.clear()
        for (i in 0 until packages.size()) {
            packages.getString(i)?.let { blockedPackages.add(it) }
        }
    }

    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        val enabledServices = Settings.Secure.getString(
            ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: ""
        val componentName = "${ctx.packageName}/com.familyguard.AppMonitorService"
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
}
