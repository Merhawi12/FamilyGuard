package com.parentix

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Collects the domains the DNS proxy sees and hands them to JS in batches.
 *
 * Every name a device resolves passes through here, so a single page load can
 * produce dozens of records for one site. Emitting each one would flood the
 * bridge and then the API, so visits are folded into one entry per domain per
 * flush window: first seen, last seen, and how many times it was resolved.
 *
 * Only the domain is ever recorded. DNS carries no path or query string, so
 * there is nothing finer-grained available here even in principle — which is
 * also what keeps this to "which sites", not "which pages".
 */
object WebHistoryReporter {

    /** How often the buffer is handed to JS. */
    private const val FLUSH_INTERVAL_MS = 30_000L

    /**
     * Ceiling on distinct domains held between flushes. Reached only when JS has
     * been unavailable for a long stretch; dropping the newest keeps the earlier
     * part of the window intact rather than losing all of it.
     */
    private const val MAX_BUFFERED_DOMAINS = 500

    private data class Visit(
        val firstSeen: Long,
        var lastSeen: Long,
        var count: Int,
        var blocked: Boolean,
    )

    private val buffer = ConcurrentHashMap<String, Visit>()
    private val lastFlush = AtomicLong(0L)

    @Volatile private var reactContext: ReactApplicationContext? = null

    fun attach(ctx: ReactApplicationContext) { reactContext = ctx }

    /**
     * Names that say nothing about browsing: reverse lookups, service discovery,
     * local network names, and the app's own backend — which the device resolves
     * precisely because it is reporting history, and which would otherwise appear
     * in every child's history as their most-visited site.
     */
    private fun isNoise(domain: String): Boolean =
        domain.endsWith(".arpa") ||
        domain.endsWith(".local") ||
        domain.endsWith(".localdomain") ||
        domain.endsWith(".internal") ||
        !domain.contains('.') ||
        domain.contains("parentix.ca")

    fun record(domain: String, blocked: Boolean) {
        val name = domain.trimEnd('.').lowercase()
        if (name.isEmpty() || isNoise(name)) return

        val now = System.currentTimeMillis()
        val existing = buffer[name]
        if (existing != null) {
            existing.lastSeen = now
            existing.count += 1
            // A domain resolved twice in one window, once blocked, is worth
            // surfacing as blocked.
            if (blocked) existing.blocked = true
        } else {
            if (buffer.size >= MAX_BUFFERED_DOMAINS) return
            buffer[name] = Visit(firstSeen = now, lastSeen = now, count = 1, blocked = blocked)
        }
    }

    /**
     * Flush if the window has elapsed. Driven from the DNS worker loop rather
     * than from `record`, so a device that resolves one name and then goes quiet
     * still reports it instead of holding it until the next lookup.
     */
    fun flushIfDue() {
        val now = System.currentTimeMillis()
        val previous = lastFlush.get()
        if (previous == 0L) { lastFlush.set(now); return }
        if (now - previous < FLUSH_INTERVAL_MS) return
        // Stamped here rather than only on success, so a flush that finds no
        // React instance is retried at the next window instead of on every pass
        // of the DNS loop.
        lastFlush.set(now)
        flush()
    }

    /**
     * Hand everything buffered to JS.
     *
     * Nothing is cleared unless the emit actually happened: if the React instance
     * is gone — the app swapped out, or still starting — the window is kept and
     * folded into the next one rather than thrown away.
     */
    @Synchronized
    fun flush() {
        if (buffer.isEmpty()) return

        val ctx = reactContext ?: return
        if (!ctx.hasActiveReactInstance()) return

        val snapshot = HashMap(buffer)
        val payload: WritableArray = Arguments.createArray()
        for ((domain, visit) in snapshot) {
            payload.pushMap(Arguments.createMap().apply {
                putString("domain", domain)
                putDouble("firstSeen", visit.firstSeen.toDouble())
                putDouble("lastSeen", visit.lastSeen.toDouble())
                putInt("count", visit.count)
                putBoolean("blocked", visit.blocked)
            })
        }

        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onWebVisits", payload)
        } catch (_: Exception) {
            // The bridge went away mid-emit — keep the buffer for the next flush.
            return
        }

        // Only the entries that were actually sent are removed, so a domain
        // recorded while this ran survives into the next window.
        for (domain in snapshot.keys) buffer.remove(domain)
        lastFlush.set(System.currentTimeMillis())
    }

    /** Drop everything — used when monitoring stops, so a later run starts clean. */
    fun clear() {
        buffer.clear()
        lastFlush.set(0L)
    }
}
