package com.parentix

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
     * Returns a map of packageName → { minutes, appName } for today's usage,
     * measured from the device's own local midnight — which is the day boundary
     * the server files a sample under, so the two have to agree.
     *
     * Requires PACKAGE_USAGE_STATS permission (Settings → Apps → Usage access).
     *
     * ── Why `queryAndAggregateUsageStats` ────────────────────────────────────
     * This used `queryUsageStats(INTERVAL_DAILY, …)` and walked the result with
     * `result.putMap(stat.packageName, appMap)` — which *overwrites*. That is
     * only correct if Android returns exactly one bucket per package, and it
     * does not guarantee that: `queryUsageStats` returns every daily bucket
     * whose interval intersects the range, so a package with two could have any
     * one of them win. The failure is silent and it can go either way — an
     * undercount hands a child screen time they have already spent, and picking
     * a bucket that began yesterday reports yesterday's total as today's,
     * locking a phone that has barely been used.
     *
     * `queryAndAggregateUsageStats` is the platform's own answer to exactly this
     * question: it merges the buckets per package with `UsageStats.add()` and
     * hands back one entry each. Using it removes the choice between overwriting
     * and hand-summing rather than picking the less wrong of the two — and it is
     * the aggregation Android itself considers authoritative, which matters for
     * a number that decides when a child's phone stops working.
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

        val aggregated = usm.queryAndAggregateUsageStats(midnight, System.currentTimeMillis())

        val result = WritableNativeMap()
        for ((packageName, stat) in aggregated) {
            if (stat.totalTimeInForeground <= 0) continue
            val appMap = WritableNativeMap()
            appMap.putDouble("minutes", stat.totalTimeInForeground / 60_000.0)
            appMap.putString("packageName", packageName)
            try {
                val info = pm.getApplicationInfo(packageName, 0)
                appMap.putString("appName", pm.getApplicationLabel(info).toString())
            } catch (_: Exception) {
                // An app uninstalled since it was used still has usage recorded
                // against it; the package name is the honest label for it.
                appMap.putString("appName", packageName)
            }
            result.putMap(packageName, appMap)
        }
        promise.resolve(result)
    }

    private fun checkPermission(): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }
}
