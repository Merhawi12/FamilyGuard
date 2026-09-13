package ca.parentix

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import com.facebook.react.bridge.*
import kotlin.concurrent.thread

class VpnModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), ActivityEventListener {

    companion object {
        const val VPN_REQUEST_CODE = 0x0FFA

        /**
         * How long `startVpn` waits for the tunnel to actually exist before
         * answering. Starting a service is asynchronous, and the answer this
         * method gives is what the phone's own Settings screen reports.
         */
        private const val START_WAIT_MS = 4_000L
    }

    private var vpnPromise: Promise? = null

    init {
        ctx.addActivityEventListener(this)
        // The DNS worker runs on a service thread with no view of the bridge;
        // this is what gives it somewhere to deliver web visits.
        WebHistoryReporter.attach(ctx)
    }

    override fun getName() = "VpnControl"

    @ReactMethod
    fun hasPermission(promise: Promise) {
        promise.resolve(VpnService.prepare(ctx) == null)
    }

    @ReactMethod
    fun requestPermission(promise: Promise) {
        val intent = VpnService.prepare(ctx) ?: run { promise.resolve(true); return }
        vpnPromise = promise
        currentActivity?.startActivityForResult(intent, VPN_REQUEST_CODE)
            ?: promise.reject("NO_ACTIVITY", "No current activity")
    }

    /**
     * Start filtering with `domains`, and resolve with whether filtering is
     * actually in force.
     *
     * Two things this used to get wrong, and both made a dead filter look live:
     *
     * - **A live `instance` was taken to mean a working tunnel.** After a reboot
     *   the service could exist with no interface at all (see
     *   `ParentixVpnService`), and this only handed it the new list. Now a
     *   service that is not filtering is started again, which is what makes it
     *   retry `establish()`.
     * - **It always resolved `true`.** The phone's Settings screen then said
     *   website blocking was on for a filter that had never come up.
     *
     * `startForegroundService` on O+, because JS also calls this from the
     * background sync task, and a plain `startService` from the background is
     * refused by Android 8 and later.
     */
    @ReactMethod
    fun startVpn(domains: ReadableArray, promise: Promise) {
        val list = ArrayList<String>().apply {
            for (i in 0 until domains.size()) domains.getString(i)?.let { add(it) }
        }

        val live = ParentixVpnService.instance
        if (live != null && live.isFiltering()) {
            live.applyDomains(list)
            promise.resolve(effective())
            return
        }

        if (VpnService.prepare(ctx) != null) {
            promise.reject("PERMISSION_REQUIRED", "Call requestPermission first")
            return
        }

        val intent = Intent(ctx, ParentixVpnService::class.java).apply {
            action = ParentixVpnService.ACTION_START
            putStringArrayListExtra(ParentixVpnService.EXTRA_DOMAINS, list)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message, e)
            return
        }

        // Off the bridge thread: this waits on the service, and nothing else the
        // app asks of native code should queue behind it.
        thread(name = "px-vpn-await", isDaemon = true) {
            val deadline = System.currentTimeMillis() + START_WAIT_MS
            while (System.currentTimeMillis() < deadline) {
                if (ParentixVpnService.instance?.isFiltering() == true) break
                try { Thread.sleep(100) } catch (_: InterruptedException) { break }
            }
            promise.resolve(effective())
        }
    }

    /**
     * Filtering is in force: the tunnel exists, and Android is not sending
     * lookups around it to a named Private DNS provider.
     */
    private fun effective(): Boolean =
        ParentixVpnService.instance?.isFiltering() == true &&
            ParentixVpnService.strictPrivateDnsServer(ctx) == null

    @ReactMethod
    fun stopVpn(promise: Promise) {
        // Hand over whatever the last window collected before the tunnel — and
        // with it the only thing that can observe DNS — goes away.
        WebHistoryReporter.flush()
        ctx.startService(Intent(ctx, ParentixVpnService::class.java).apply { action = ParentixVpnService.ACTION_STOP })
        promise.resolve(true)
    }

    /** Let JS pull the current window early, e.g. before a background sync. */
    @ReactMethod
    fun flushWebHistory(promise: Promise) {
        WebHistoryReporter.flush()
        promise.resolve(true)
    }

    // Required by RN's NativeEventEmitter for the "onWebVisits" event.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Double) {}

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != VPN_REQUEST_CODE) return
        vpnPromise?.resolve(resultCode == Activity.RESULT_OK); vpnPromise = null
    }

    override fun onNewIntent(intent: Intent?) {}
}
