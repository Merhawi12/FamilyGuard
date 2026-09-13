package ca.parentix

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Local VPN that proxies DNS (UDP/53). Blocked domains get NXDOMAIN; everything
 * else is forwarded to a public resolver. Nothing leaves the phone to a server
 * of ours — the "VPN" is a loopback that only ever sees lookups. The byte-level
 * work is in `DnsPacket`, where it can be unit tested.
 *
 * ── What was wrong ────────────────────────────────────────────────────────────
 *
 * Reported as "I block a website and it is still accessible on the child's
 * phone". Reproduced on an Android 14 emulator against the shipping APK, and
 * each fix below was then checked against the same reproduction:
 *
 * 1. **After a reboot the filter never came up — while saying it had.** Android
 *    forgets which app is the prepared VPN across a reboot, and `establish()`
 *    returns null for an app that has not been prepared since. The boot path
 *    (`BootReceiver` → here) never called `prepare()`. Observed: foreground
 *    notification up, no tun device, no worker thread, every lookup unfiltered.
 *    **Now** the service calls `prepare()` itself before every `establish()`;
 *    with the child's standing consent that silently re-prepares it. Observed:
 *    prepared package flips to Parentix, tun0 up, blocked names refused in about
 *    100 ms while allowed names resolve through the worker.
 *
 * 2. **A failed start was unrecoverable.** `running` was set before
 *    `establish()`, the worker thread returned on a null interface without a
 *    word, and every later start was skipped because `running` was still true.
 *    `VpnModule` saw a live `instance` and only swapped the domain list.
 *    **Now** `running` is set only once an interface exists; a start that cannot
 *    filter tears the service down, notification included, and `VpnModule`
 *    restarts a service that is not filtering instead of trusting it.
 *
 * 3. **A site the child had just visited stayed reachable after it was
 *    blocked.** Observed: `wikipedia.org` resolved, was added to the running
 *    filter, and still resolved — its answer came from Android's resolver
 *    cache, and the query never reached the filter to be refused. A block on a
 *    name that had not been looked up recently bit immediately. Re-establishing
 *    the tunnel with a different DNS server address was tried first and did
 *    **not** clear that cache on Android 14; it is gone. **Now** every answer the
 *    filter forwards has its lifetime capped at `MAX_TTL_SECONDS`, so no cached
 *    "allowed" can outlive a new block by longer than that. A browser may keep a
 *    copy of its own for a little longer, and a connection already open to the
 *    site is not a lookup at all — no DNS filter can end one.
 */
class ParentixVpnService : VpnService() {

    companion object {
        const val ACTION_START = "ca.parentix.VPN_START"
        const val ACTION_STOP  = "ca.parentix.VPN_STOP"
        const val EXTRA_DOMAINS = "domains"
        const val CHANNEL_ID = "px_vpn"
        const val NOTIF_ID = 2

        private const val TAG = "ParentixVpn"
        private const val PREFS = "px_blocking"
        private const val KEY_DOMAINS = "blocked_domains"

        /**
         * TEST-NET-1 (RFC 5737), and not 10.0.0.x.
         *
         * These addresses are reserved for documentation and never appear on a
         * real network. 10.0.0.1 is the default gateway of a great many home
         * routers, so routing it into this tunnel took a router's own admin page
         * off the network for a child on one.
         */
        private const val TUN_ADDRESS = "192.0.2.2"
        private const val FAKE_DNS = "192.0.2.1"

        private const val UPSTREAM_DNS = "8.8.8.8"
        private const val UPSTREAM_TIMEOUT_MS = 2_000

        /**
         * Large enough for an EDNS0 answer. At 512 bytes a longer response — an
         * HTTPS record, a CDN with many addresses — was cut short with no
         * truncation flag set, which a resolver reads as a corrupt packet.
         */
        private const val UPSTREAM_BUFFER = 4_096

        /**
         * The longest any forwarded answer may be cached for. See fault 3 above.
         *
         * Thirty seconds bounds a new block's delay without making the phone look
         * up the same name constantly — a page's resources share a handful of
         * names, and re-resolving each twice a minute is a few small packets.
         */
        const val MAX_TTL_SECONDS = 30

        /** How long the worker waits when the non-blocking read finds nothing. */
        private const val IDLE_PARK_MS = 10L

        /**
         * Names refused so that browsers fall back to the system resolver — this
         * tunnel — instead of resolving over their own encrypted channel, where
         * nothing here can see or filter the lookup.
         *
         * The same policy as the desktop agent's resolver (`dns/proxy.js`), minus
         * the provider hostnames that are *also* Android Private DNS servers:
         * `dns.google`, `dns.quad9.net`, `dns.adguard*`, `*.dns.nextdns.io`.
         * Refusing one of those through the tunnel risks breaking every lookup on
         * a phone whose Private DNS is set to it, which is a far worse outcome
         * than the bypass it would close. That case is detected and reported
         * instead — see `strictPrivateDnsServer`.
         */
        private val BOOTSTRAP_REFUSED = setOf(
            // Firefox asks for this before turning DNS-over-HTTPS on; an NXDOMAIN
            // is the documented signal that the network's resolver must be used.
            "use-application-dns.net",
            "mozilla.cloudflare-dns.com",
            "chrome.cloudflare-dns.com",
            "chromium.dns.nextdns.io",
            "doh.opendns.com",
            "doh.cleanbrowsing.org",
        )

        @Volatile var instance: ParentixVpnService? = null

        fun persistDomains(ctx: Context, domains: Collection<String>) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putStringSet(KEY_DOMAINS, HashSet(domains)).apply()
        }

        fun loadPersistedDomains(ctx: Context): Set<String> =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getStringSet(KEY_DOMAINS, emptySet()) ?: emptySet()

        fun clearPersistedDomains(ctx: Context) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(KEY_DOMAINS).apply()
        }

        /**
         * The Private DNS provider, when Android is set to use one by name.
         *
         * In that mode every lookup goes over TLS straight to the named provider
         * and never enters this tunnel, so nothing is filtered or recorded. An app
         * cannot change the setting, so the honest response is to say so. Asked
         * of this app's own default network, which is the underlying one — the
         * app is excluded from its own VPN.
         */
        fun strictPrivateDnsServer(ctx: Context): String? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
            return try {
                val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return null
                val lp = cm.getLinkProperties(cm.activeNetwork) ?: return null
                if (lp.isPrivateDnsActive) lp.privateDnsServerName else null
            } catch (_: Exception) {
                null
            }
        }
    }

    private val lock = Any()
    private val running = AtomicBoolean(false)
    @Volatile private var vpnIface: ParcelFileDescriptor? = null

    /**
     * Which tunnel is current. `teardown()` bumps it so a worker still blocked
     * on its read exits as retired rather than racing whatever comes next.
     */
    @Volatile private var generation = 0

    /**
     * Replaced whole, never mutated. It used to be a mutable set cleared and
     * refilled from the React Native thread while the DNS worker iterated it —
     * a window in which every lookup was unblocked, and a
     * `ConcurrentModificationException` waiting to happen on the worker.
     */
    @Volatile private var blockedDomains: Set<String> = emptySet()

    /** True only while an interface exists and its worker is reading from it. */
    fun isFiltering(): Boolean = running.get() && vpnIface != null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            clearPersistedDomains(applicationContext)
            stopVpn()
            return START_NOT_STICKY
        }

        // Before anything slow: a service started with startForegroundService has
        // five seconds to call startForeground or the system kills the app.
        startForegroundNotification()
        instance = this

        // On a sticky restart the intent is null; fall back to the persisted list
        // so website blocking survives the process being killed.
        val domains = intent?.getStringArrayListExtra(EXTRA_DOMAINS)
            ?: loadPersistedDomains(applicationContext).toList()
        applyDomains(domains)
        return START_STICKY
    }

    override fun onDestroy() {
        teardown()
        instance = null
        super.onDestroy()
    }

    /**
     * Replace the block list, and make sure something is enforcing it.
     *
     * The swap is atomic and takes effect on the very next lookup. What it cannot
     * reach is an answer already cached by the system, which is what the TTL cap
     * in `forwardToRealDns` is for.
     */
    fun applyDomains(domains: Collection<String>) {
        val next = domains.map { it.trim().lowercase().trimEnd('.') }
            .filter { it.isNotEmpty() }
            .toSet()
        blockedDomains = next
        persistDomains(applicationContext, next)

        synchronized(lock) {
            if (!isFiltering() && !establishTunnel()) stopWithoutFiltering()
        }
    }

    /**
     * Bring up the interface and its worker. Call with `lock` held.
     *
     * `running` is set only after `establish()` has returned an interface, which
     * is the whole of fault 2.
     */
    private fun establishTunnel(): Boolean {
        // Fault 1. With the consent the child already gave, prepare() returns null
        // and makes Parentix the prepared VPN again — which a reboot undoes.
        // Non-null means that consent is gone (revoked in Settings, or another VPN
        // is set to always-on) and establish() would refuse us anyway.
        if (VpnService.prepare(this) != null) {
            Log.w(TAG, "VPN consent is not held; website filtering cannot start")
            return false
        }

        val iface = try {
            Builder()
                .addAddress(TUN_ADDRESS, 32)
                .addDnsServer(FAKE_DNS)
                .addRoute(FAKE_DNS, 32)
                .addDisallowedApplication(packageName)
                .setSession("Parentix")
                .setBlocking(false)
                .establish()
        } catch (e: Exception) {
            Log.w(TAG, "establish() threw: ${e.javaClass.simpleName}")
            null
        }
        if (iface == null) {
            Log.w(TAG, "establish() returned no interface; website filtering cannot start")
            return false
        }

        vpnIface = iface
        val gen = ++generation
        running.set(true)
        thread(name = "px-vpn-worker", isDaemon = true) { processDnsPackets(iface, gen) }
        return true
    }

    /**
     * Give up, visibly.
     *
     * The notification goes too. "Web activity monitoring active" over a tunnel
     * that does not exist is precisely what a parent checking the phone would
     * have trusted.
     */
    private fun stopWithoutFiltering() {
        teardown()
        stopForegroundCompat()
        stopSelf()
    }

    private fun stopVpn() {
        teardown()
        stopForegroundCompat()
        stopSelf()
    }

    private fun teardown() {
        synchronized(lock) {
            running.set(false)
            generation++ // retires any worker still reading
            try { vpnIface?.close() } catch (_: Exception) {}
            vpnIface = null
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun processDnsPackets(iface: ParcelFileDescriptor, gen: Int) {
        val inStream  = FileInputStream(iface.fileDescriptor)
        val outStream = FileOutputStream(iface.fileDescriptor)
        val buf = ByteBuffer.allocate(32_767)
        val upstream = try {
            DatagramSocket().also { protect(it) }
        } catch (e: Exception) {
            Log.w(TAG, "could not open the upstream socket: ${e.javaClass.simpleName}")
            if (generation == gen) running.set(false)
            return
        }
        val realDns = InetAddress.getByName(UPSTREAM_DNS)

        try {
            while (running.get() && generation == gen) {
                WebHistoryReporter.flushIfDue()
                buf.clear()
                val len = try { inStream.channel.read(buf) } catch (_: Exception) { break }
                if (len < 0) break
                if (len == 0) {
                    // Non-blocking read, nothing waiting. Park rather than spin a
                    // core at 100% for as long as the phone is on.
                    try { Thread.sleep(IDLE_PARK_MS) } catch (_: InterruptedException) { break }
                    continue
                }
                buf.flip()
                val raw = ByteArray(len).also { buf.get(it) }
                if (!DnsPacket.isUdpDns(raw)) continue
                val dns = DnsPacket.udpPayload(raw) ?: continue
                val domain = DnsPacket.queryDomain(dns)
                val refusedBootstrap = domain != null && DnsPacket.matches(domain, BOOTSTRAP_REFUSED)
                val blocked = domain != null &&
                    (refusedBootstrap || DnsPacket.matches(domain, blockedDomains))

                // Every resolved name is history, whether or not it was allowed —
                // a blocked attempt is exactly what a parent opens that screen to
                // see. The bootstrap names are not browsing and are left out.
                if (domain != null && !refusedBootstrap) WebHistoryReporter.record(domain, blocked)

                val responsePayload = if (blocked)
                    DnsPacket.nxDomain(dns)
                else
                    forwardToRealDns(upstream, realDns, dns) ?: continue
                try { outStream.write(DnsPacket.udpResponse(raw, responsePayload)) } catch (_: Exception) {}
            }
        } finally {
            upstream.close()
            // A quiet device may hold a partial window for a long time; flush what
            // is buffered before the worker exits so it is not lost with the thread.
            WebHistoryReporter.flush()
            // Only the current tunnel's worker may declare the filter stopped.
            if (generation == gen) running.set(false)
        }
    }

    /**
     * Relay one query, wait for *its* answer, and cap how long it may be cached.
     *
     * One socket serves every lookup, so a reply that arrived after its query had
     * already timed out used to be read as the answer to the next one — a
     * different question, a mismatched id, and a retry for the app that asked.
     */
    private fun forwardToRealDns(socket: DatagramSocket, dns: InetAddress, query: ByteArray): ByteArray? = try {
        socket.soTimeout = UPSTREAM_TIMEOUT_MS
        socket.send(DatagramPacket(query, query.size, dns, 53))
        val buf = ByteArray(UPSTREAM_BUFFER)
        var answer: ByteArray? = null
        while (answer == null) {
            val resp = DatagramPacket(buf, buf.size)
            socket.receive(resp) // throws on timeout
            if (resp.length >= 2 && buf[0] == query[0] && buf[1] == query[1]) {
                answer = DnsPacket.capTtls(buf.copyOf(resp.length), MAX_TTL_SECONDS)
            }
        }
        answer
    } catch (_: Exception) { null }

    private fun startForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Parentix VPN", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Parentix")
            // The tunnel runs for history collection as well as filtering, so the
            // text says what is actually happening rather than naming only the
            // case where a block rule exists.
            .setContentText("Web activity monitoring active")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        // Android 14 (API 34) requires a declared foregroundServiceType, or
        // startForeground throws MissingForegroundServiceTypeException. The type is
        // only required/valid from API 34 up; older versions take the untyped call.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }
}
