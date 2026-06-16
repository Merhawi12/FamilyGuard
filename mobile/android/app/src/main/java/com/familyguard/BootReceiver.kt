package com.familyguard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        context.startService(Intent(context, FamilyGuardVpnService::class.java).apply {
            action = FamilyGuardVpnService.ACTION_START
        })
    }
}
