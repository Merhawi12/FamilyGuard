package com.parentix

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
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
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return

        if (pkg == applicationContext.packageName) return
        if (pkg.startsWith("com.android.launcher") || pkg.startsWith("com.google.android.apps.nexuslauncher")) return

        val blocked = AppBlockerModule.blockedPackages
        if (blocked.isEmpty()) return

        if (blocked.contains("*") || blocked.contains(pkg)) {
            performGlobalAction(GLOBAL_ACTION_HOME)
            // Alert the parent for specific-app blocks only; the "*" case is the
            // screen-time limit, which is reported separately by the RN layer.
            if (!blocked.contains("*")) AppBlockerModule.notifyBlocked(pkg)
        }
    }

    override fun onInterrupt() {}
}
