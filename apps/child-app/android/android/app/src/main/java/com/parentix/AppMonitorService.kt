package com.parentix

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.os.Build
import android.provider.Telephony
import android.telecom.TelecomManager
import android.view.accessibility.AccessibilityEvent

class AppMonitorService : AccessibilityService() {

    override fun onServiceConnected() {
        serviceInfo = serviceInfo.apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = 100
        }
        // The system can restart this service after the app process is killed, with
        // an empty in-memory block set. Restore the persisted rules so enforcement
        // continues without the user reopening the app.
        AppBlockerModule.loadPersisted(applicationContext)
        // Resolved once here rather than per event: the default dialer and
        // messaging app change about as often as a person changes phones, and this
        // runs on the foreground path of every window change on the device.
        alwaysAllowed(applicationContext)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return

        if (pkg == applicationContext.packageName) return
        if (pkg.startsWith("com.android.launcher") || pkg.startsWith("com.google.android.apps.nexuslauncher")) return

        /**
         * The safety exception, checked before any rule.
         *
         * Nothing below this line can take the phone away from a child, and that
         * is the whole point of putting it here rather than in the rules the
         * server sends: it holds when the app process is dead, when the device has
         * been offline for a week, and when a parent has paused the device
         * outright. A wildcard lock used to bounce the dialer to the home screen
         * along with everything else, so a child who had spent their ninety
         * minutes could not ring anyone — on a product a family installs to make
         * that child safer.
         *
         * It is deliberately not configurable. A parent cannot switch off the
         * ability to make a call, because the failure mode of that switch is a
         * child who needs help and cannot ask for it, and no amount of parental
         * intent makes that an acceptable outcome.
         */
        if (alwaysAllowed(applicationContext).contains(pkg)) return

        val blocked = AppBlockerModule.blockedPackages
        if (blocked.isEmpty()) return

        if (blocked.contains("*")) {
            // The parent's own allowlist, which only arrives populated for a
            // `daily_limit` lock — bedtime and an out-of-hours schedule clear it.
            // See schedule.js, which owns that decision for both clients.
            if (AppBlockerModule.allowedPackages.contains(pkg.lowercase())) return
            performGlobalAction(GLOBAL_ACTION_HOME)
            // No alert: the "*" case is the screen-time limit, which the RN layer
            // reports separately and once per day.
            return
        }

        if (blocked.contains(pkg)) {
            performGlobalAction(GLOBAL_ACTION_HOME)
            AppBlockerModule.notifyBlocked(pkg)
        }
    }

    override fun onInterrupt() {}

    companion object {
        /**
         * Packages no rule may block, on any device.
         *
         * Two halves, because neither is sufficient on its own:
         *
         *  - **Resolved from the system.** `TelecomManager.getDefaultDialerPackage`
         *    and `Telephony.Sms.getDefaultSmsPackage` name whichever apps this
         *    child actually places calls and sends messages with. A hard-coded
         *    list cannot know that Samsung ships its own dialer, or that the
         *    family uses a third-party SMS app.
         *  - **A static floor.** The resolvers answer null on a tablet with no
         *    telephony, and neither of them names the in-call UI, the emergency
         *    information app, the clock a child sets an alarm on, or Settings —
         *    which is where this app sends them to grant its own permissions, so
         *    blocking it makes the product unrecoverable from a lock.
         *
         * The in-call screen is the entry that matters most and is the least
         * obvious: on modern Android an incoming call is a window belonging to
         * `com.android.server.telecom` or to the dialer, so a wildcard lock did
         * not merely stop a child ringing out — it bounced away a parent ringing
         * in.
         *
         * Cached after the first resolve. It is read on every window change.
         */
        @Volatile private var cached: Set<String>? = null

        private val STATIC_ALLOWED = setOf(
            // Placing and receiving calls, including the emergency dialer.
            "com.android.dialer",
            "com.google.android.dialer",
            "com.samsung.android.dialer",
            "com.android.phone",
            "com.android.server.telecom",
            "com.android.incallui",
            "com.android.emergency",
            // Messaging and the address book behind it.
            "com.android.mms",
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.android.contacts",
            "com.google.android.contacts",
            "com.samsung.android.app.contacts",
            // The clock, because an alarm is the other thing a locked phone owes
            // its owner, and Settings, because this app's own permission screens
            // are inside it.
            "com.android.deskclock",
            "com.google.android.deskclock",
            "com.sec.android.app.clockpackage",
            "com.android.settings",
            // Core system UI. Blocking any of these turns a lock into a phone that
            // cannot be answered rather than one that cannot be played with.
            "com.android.systemui",
            "android",
        )

        /** The full set for this device, resolved once and cached. */
        fun alwaysAllowed(context: Context): Set<String> {
            cached?.let { return it }

            val resolved = mutableSetOf<String>()
            resolved.addAll(STATIC_ALLOWED)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
                    telecom?.defaultDialerPackage?.let { resolved.add(it) }
                } catch (_: Throwable) {
                    // A tablet with no telephony, or an OEM that refuses the call.
                    // The static floor still covers the ordinary dialers.
                }
            }

            try {
                Telephony.Sms.getDefaultSmsPackage(context)?.let { resolved.add(it) }
            } catch (_: Throwable) {
                // Same: no messaging on this device, and nothing to add.
            }

            val frozen = resolved.toSet()
            cached = frozen
            return frozen
        }
    }
}
