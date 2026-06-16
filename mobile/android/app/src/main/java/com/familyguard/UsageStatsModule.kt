package com.familyguard

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
import com.facebook.react.bridge.*
import java.util.Calendar

class UsageStatsModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "UsageStats"

    @ReactMethod
    fun hasPermission(promise: Promise) {
        promise.resolve(checkPermission())
    }

    @ReactMethod
    fun openSettings() {
        val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        ctx.startActivity(intent)
    }

    /**
     * Returns a map of packageName → { minutes, appName } for today's usage.
     * Requires PACKAGE_USAGE_STATS permission (Settings → Apps → Usage access).
     */
    @ReactMethod
    fun getUsageStats(promise: Promise) {
        if (!checkPermission()) {
            promise.reject("PERMISSION_DENIED", "Usage access not granted")
            return
        }

        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val pm = ctx.packageManager

        val midnight = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, midnight, System.currentTimeMillis())

        val result = WritableNativeMap()
        for (stat in stats) {
            if (stat.totalTimeInForeground <= 0) continue
            val appMap = WritableNativeMap()
            appMap.putDouble("minutes", stat.totalTimeInForeground / 60_000.0)
            appMap.putString("packageName", stat.packageName)
            try {
                val info = pm.getApplicationInfo(stat.packageName, 0)
                appMap.putString("appName", pm.getApplicationLabel(info).toString())
            } catch (_: Exception) {
                appMap.putString("appName", stat.packageName)
            }
            result.putMap(stat.packageName, appMap)
        }
        promise.resolve(result)
    }

    private fun checkPermission(): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }
}
