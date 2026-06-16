package com.familyguard

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import com.facebook.react.bridge.*

class VpnModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), ActivityEventListener {

    companion object { const val VPN_REQUEST_CODE = 0x0FFA }

    private var vpnPromise: Promise? = null

    init { ctx.addActivityEventListener(this) }

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

    @ReactMethod
    fun startVpn(domains: ReadableArray, promise: Promise) {
        val list = ArrayList<String>().apply { for (i in 0 until domains.size()) domains.getString(i)?.let { add(it) } }
        FamilyGuardVpnService.instance?.let { it.updateBlockedDomains(list); promise.resolve(true); return }
        if (VpnService.prepare(ctx) != null) { promise.reject("PERMISSION_REQUIRED", "Call requestPermission first"); return }
        ctx.startService(Intent(ctx, FamilyGuardVpnService::class.java).apply {
            action = FamilyGuardVpnService.ACTION_START
            putStringArrayListExtra(FamilyGuardVpnService.EXTRA_DOMAINS, list)
        })
        promise.resolve(true)
    }

    @ReactMethod
    fun stopVpn(promise: Promise) {
        ctx.startService(Intent(ctx, FamilyGuardVpnService::class.java).apply { action = FamilyGuardVpnService.ACTION_STOP })
        promise.resolve(true)
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != VPN_REQUEST_CODE) return
        vpnPromise?.resolve(resultCode == Activity.RESULT_OK); vpnPromise = null
    }

    override fun onNewIntent(intent: Intent?) {}
}
