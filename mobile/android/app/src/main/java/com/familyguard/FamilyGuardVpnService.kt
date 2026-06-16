package com.familyguard

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
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
 * Local VPN that proxies DNS (UDP/53) traffic. Blocked domains get NXDOMAIN;
 * all other queries are forwarded to 8.8.8.8. No external VPN server is used.
 *
 * VPN interface: 10.0.0.2/32
 * Fake DNS:      10.0.0.1  (routed through the tunnel)
 * Real upstream: 8.8.8.8:53
 */
class FamilyGuardVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.familyguard.VPN_START"
        const val ACTION_STOP  = "com.familyguard.VPN_STOP"
        const val EXTRA_DOMAINS = "domains"
        const val CHANNEL_ID = "fg_vpn"
        const val NOTIF_ID = 2

        var instance: FamilyGuardVpnService? = null
    }

    private var vpnIface: ParcelFileDescriptor? = null
    private val running = AtomicBoolean(false)
    private val blockedDomains = mutableSetOf<String>()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopVpn(); return START_NOT_STICKY }

        val domains = intent?.getStringArrayListExtra(EXTRA_DOMAINS) ?: arrayListOf()
        blockedDomains.clear()
        blockedDomains.addAll(domains.map { it.lowercase().trimEnd('.') })

        startForegroundNotification()
        startVpn()
        instance = this
        return START_STICKY
    }

    override fun onDestroy() { stopVpn(); instance = null; super.onDestroy() }

    fun updateBlockedDomains(domains: List<String>) {
        blockedDomains.clear()
        blockedDomains.addAll(domains.map { it.lowercase().trimEnd('.') })
    }

    private fun startVpn() {
        if (running.getAndSet(true)) return
        vpnIface = Builder()
            .addAddress("10.0.0.2", 32)
            .addDnsServer("10.0.0.1")
            .addRoute("10.0.0.1", 32)
            .addDisallowedApplication(packageName)
            .setSession("FamilyGuard")
            .setBlocking(false)
            .establish()
        thread(name = "fg-vpn-worker", isDaemon = true) { processDnsPackets() }
    }

    private fun stopVpn() {
        running.set(false)
        vpnIface?.close(); vpnIface = null
        stopForeground(true); stopSelf()
    }

    private fun processDnsPackets() {
        val iface = vpnIface ?: return
        val inStream  = FileInputStream(iface.fileDescriptor)
        val outStream = FileOutputStream(iface.fileDescriptor)
        val buf = ByteBuffer.allocate(32_767)
        val upstream = DatagramSocket().also { protect(it) }
        val realDns  = InetAddress.getByName("8.8.8.8")

        while (running.get()) {
            buf.clear()
            val len = try { inStream.channel.read(buf) } catch (_: Exception) { break }
            if (len <= 0) continue
            buf.flip()
            val raw = ByteArray(len).also { buf.get(it) }
            if (!isUdpDns(raw)) continue
            val dns = extractDnsPayload(raw) ?: continue
            val domain = parseDnsQueryDomain(dns)
            val responsePayload = if (domain != null && isBlocked(domain))
                buildNxDomainResponse(dns)
            else
                forwardToRealDns(upstream, realDns, dns) ?: continue
            try { outStream.write(buildUdpIpResponse(raw, responsePayload)) } catch (_: Exception) {}
        }
        upstream.close()
    }

    private fun isUdpDns(p: ByteArray): Boolean {
        if (p.size < 28) return false
        if (p[9].toInt() and 0xFF != 17) return false
        val ihl = (p[0].toInt() and 0x0F) * 4
        val dstPort = ((p[ihl+2].toInt() and 0xFF) shl 8) or (p[ihl+3].toInt() and 0xFF)
        return dstPort == 53
    }

    private fun extractDnsPayload(p: ByteArray): ByteArray? {
        val ihl = (p[0].toInt() and 0x0F) * 4
        val end = ihl + 8
        return if (p.size > end) p.copyOfRange(end, p.size) else null
    }

    private fun parseDnsQueryDomain(dns: ByteArray): String? {
        if (dns.size < 12) return null
        val sb = StringBuilder(); var i = 12
        while (i < dns.size) {
            val len = dns[i].toInt() and 0xFF
            if (len == 0) break
            if (i + 1 + len > dns.size) return null
            if (sb.isNotEmpty()) sb.append('.')
            sb.append(String(dns, i + 1, len))
            i += 1 + len
        }
        return if (sb.isEmpty()) null else sb.toString().lowercase()
    }

    private fun isBlocked(domain: String): Boolean {
        val d = domain.trimEnd('.')
        return blockedDomains.any { b -> d == b || d.endsWith(".$b") }
    }

    private fun forwardToRealDns(socket: DatagramSocket, dns: InetAddress, query: ByteArray): ByteArray? = try {
        socket.send(DatagramPacket(query, query.size, dns, 53))
        val buf = ByteArray(512); val resp = DatagramPacket(buf, buf.size)
        socket.soTimeout = 2_000; socket.receive(resp)
        buf.copyOf(resp.length)
    } catch (_: Exception) { null }

    private fun buildNxDomainResponse(query: ByteArray): ByteArray {
        val r = query.copyOf()
        r[2] = 0x81.toByte(); r[3] = 0x83.toByte()
        for (k in 6..11) r[k] = 0
        return r
    }

    private fun buildUdpIpResponse(req: ByteArray, dns: ByteArray): ByteArray {
        val ihl = (req[0].toInt() and 0x0F) * 4
        val udpLen = 8 + dns.size; val total = ihl + udpLen
        val p = ByteArray(total)
        p[0] = req[0]; p[1] = 0
        p[2] = ((total shr 8) and 0xFF).toByte(); p[3] = (total and 0xFF).toByte()
        p[4] = 0; p[5] = 0; p[6] = 0x40; p[7] = 0; p[8] = 64; p[9] = 17
        System.arraycopy(req, 16, p, 12, 4)   // swap src/dst IPs
        System.arraycopy(req, 12, p, 16, 4)
        p[10] = 0; p[11] = 0
        val csum = ipChecksum(p, ihl)
        p[10] = ((csum shr 8) and 0xFF).toByte(); p[11] = (csum and 0xFF).toByte()
        p[ihl+0] = req[ihl+2]; p[ihl+1] = req[ihl+3]  // swap ports
        p[ihl+2] = req[ihl+0]; p[ihl+3] = req[ihl+1]
        p[ihl+4] = ((udpLen shr 8) and 0xFF).toByte(); p[ihl+5] = (udpLen and 0xFF).toByte()
        p[ihl+6] = 0; p[ihl+7] = 0
        System.arraycopy(dns, 0, p, ihl + 8, dns.size)
        return p
    }

    private fun ipChecksum(h: ByteArray, len: Int): Int {
        var s = 0; var i = 0
        while (i < len - 1) { s += ((h[i].toInt() and 0xFF) shl 8) or (h[i+1].toInt() and 0xFF); i += 2 }
        if (len % 2 != 0) s += (h[len-1].toInt() and 0xFF) shl 8
        while (s shr 16 != 0) s = (s and 0xFFFF) + (s shr 16)
        return s.inv() and 0xFFFF
    }

    private fun startForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "FamilyGuard VPN", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
        startForeground(NOTIF_ID, NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("FamilyGuard")
            .setContentText("Website filtering active")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build())
    }
}
