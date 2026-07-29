package com.parentix

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        // App blocking restores itself via AppMonitorService.onServiceConnected().
        // Only (re)start the VPN if there are persisted domains to filter — otherwise
        // we'd show a "filtering active" notification while nothing is enforced.
        if (ParentixVpnService.loadPersistedDomains(context).isEmpty()) return

        val svc = Intent(context, ParentixVpnService::class.java).apply {
            action = ParentixVpnService.ACTION_START
        }
        // On O+ a background start of a service that calls startForeground must use
        // startForegroundService, or the system throws.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(svc)
        } else {
            context.startService(svc)
        }
    }
}
