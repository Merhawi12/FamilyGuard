package ca.parentix

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The packet handling behind website blocking, run against real traffic.
 *
 * The three responses below were captured from 8.8.8.8 on 2026-09-12 with an
 * EDNS0 query, so each carries what a hand-written fixture tends to leave out:
 * compression pointers everywhere, CNAME chains, and an OPT record in the
 * additional section. They are exactly the answers that let a blocked site go
 * on loading — the CNAMEs say they may be cached for hours.
 */
class DnsPacketTest {

    // google.com A: one answer (TTL 64 s at 34), then OPT (flags field at 49).
    private val googleHex =
        "abcd8180000100010000000106676f6f676c6503636f6d0000010001c00c000100010000004000048efb2d8e0000290200000000000000"

    // www.wikipedia.org A: CNAME (14,420 s) → dyna.wikimedia.org, A (66 s), OPT.
    private val wikipediaHex =
        "abcd81800001000200000001037777770977696b697065646961036f72670000010001c00c000500010000385400110464796e610977696b696d65646961c01ac02f00010001000000420004c6231ae00000290200000000000000"

    // www.bbc.co.uk A: CNAME (21,468 s), CNAME (300 s), four A (50 s each), OPT.
    private val bbcHex =
        "abcd81800001000600000001037777770362626302636f02756b0000010001c00c00050001000053dc0014037777770362626302636f02756b03707269c010c02b000500010000012c001403626263036d617006666173746c79036e657400c04b0001000100000032000497650051c04b000100010000003200049765c051c04b0001000100000032000497654051c04b00010001000000320004976580510000290200000000000000"

    // The query that asks for www.bbc.co.uk, with its own OPT record.
    private val bbcQueryHex =
        "abcd010000010000000000010377777703626263" + "02636f02756b0000010001" + "00002904d0000000000000"

    // ── TTL capping ─────────────────────────────────────────────────────────

    @Test
    fun `caps every answer above the limit, CNAMEs included`() {
        val capped = DnsPacket.capTtls(hex(bbcHex), 30)
        assertEquals(listOf(5 to 30L, 5 to 30L, 1 to 30L, 1 to 30L, 1 to 30L, 1 to 30L, 41 to 0L), records(capped))
    }

    @Test
    fun `leaves lifetimes already under the limit alone`() {
        val capped = DnsPacket.capTtls(hex(bbcHex), 120)
        assertEquals(listOf(5 to 120L, 5 to 120L, 1 to 50L, 1 to 50L, 1 to 50L, 1 to 50L, 41 to 0L), records(capped))
    }

    @Test
    fun `rewrites the TTL at the byte it lives at`() {
        val capped = DnsPacket.capTtls(hex(googleHex), 30)
        assertEquals(30L, u32(capped, 34))
        // Nothing else in the packet moves.
        val expected = hex(googleHex).also { it[37] = 30 }
        assertArrayEquals(expected, capped)
    }

    @Test
    fun `follows compression pointers across a CNAME chain`() {
        assertEquals(listOf(5 to 30L, 1 to 30L, 41 to 0L), records(DnsPacket.capTtls(hex(wikipediaHex), 30)))
    }

    @Test
    fun `never touches an OPT record, whose TTL field is flags`() {
        // DO bit set, as a DNSSEC-aware resolver sends it. A cap of 30 would turn
        // 0x00008000 (32,768) into 30 and silently clear the flag.
        val withFlags = hex(googleHex).also { it[51] = 0x80.toByte() }
        val capped = DnsPacket.capTtls(withFlags.copyOf(), 30)
        assertEquals(0x8000L, u32(capped, 49))
    }

    @Test
    fun `returns an unreadable message exactly as it arrived`() {
        val original = hex(bbcHex)
        for (cut in listOf(5, 20, 40, 100, original.size - 3)) {
            val truncated = original.copyOf(cut)
            assertArrayEquals("cut at $cut", truncated.copyOf(), DnsPacket.capTtls(truncated, 30))
        }
        // A reserved label type (0x40) where a name should be.
        val reserved = hex(googleHex).also { it[28] = 0x40 }
        assertArrayEquals(reserved.copyOf(), DnsPacket.capTtls(reserved, 30))
    }

    // ── The refusal ─────────────────────────────────────────────────────────

    @Test
    fun `an NXDOMAIN carries the question and nothing after it`() {
        val query = hex(bbcQueryHex)
        val nx = DnsPacket.nxDomain(query)
        assertEquals(31, nx.size) // header + www.bbc.co.uk A IN, the OPT record dropped
        assertEquals(0xab, nx[0].toInt() and 0xFF)
        assertEquals(0xcd, nx[1].toInt() and 0xFF)
        assertEquals("QR set, RD kept", 0x81, nx[2].toInt() and 0xFF)
        assertEquals("RA, RCODE 3", 0x83, nx[3].toInt() and 0xFF)
        assertEquals("one question", 1, (nx[4].toInt() shl 8) or nx[5].toInt())
        for (k in 6..11) assertEquals("count byte $k", 0, nx[k].toInt())
        assertArrayEquals(query.copyOfRange(12, 31), nx.copyOfRange(12, 31))
    }

    @Test
    fun `reads the queried name`() {
        assertEquals("www.bbc.co.uk", DnsPacket.queryDomain(hex(bbcQueryHex)))
        assertEquals(31, DnsPacket.questionEnd(hex(bbcQueryHex)))
        assertNull(DnsPacket.queryDomain(ByteArray(5)))
    }

    // ── Matching ────────────────────────────────────────────────────────────

    @Test
    fun `matches a domain and everything below it, on label boundaries`() {
        val rules = setOf("example.com")
        assertTrue(DnsPacket.matches("example.com", rules))
        assertTrue(DnsPacket.matches("www.example.com", rules))
        assertTrue(DnsPacket.matches("a.b.example.com", rules))
        assertTrue(DnsPacket.matches("EXAMPLE.COM.", rules))
        assertFalse(DnsPacket.matches("notexample.com", rules))
        assertFalse(DnsPacket.matches("example.com.evil.net", rules))
        assertFalse(DnsPacket.matches("com", rules))
        assertFalse(DnsPacket.matches("example.com", emptySet()))
    }

    // ── IPv4 / UDP ──────────────────────────────────────────────────────────

    @Test
    fun `wraps a reply addressed back to the asker, with a valid checksum`() {
        val query = hex(bbcQueryHex)
        val packet = ipv4Udp(src = byteArrayOf(192.toByte(), 0, 2, 2), dst = byteArrayOf(192.toByte(), 0, 2, 1),
            srcPort = 40_000, dstPort = 53, payload = query)

        assertTrue(DnsPacket.isUdpDns(packet))
        assertArrayEquals(query, DnsPacket.udpPayload(packet))

        val reply = DnsPacket.udpResponse(packet, DnsPacket.nxDomain(query))
        assertArrayEquals(byteArrayOf(192.toByte(), 0, 2, 1), reply.copyOfRange(12, 16))
        assertArrayEquals(byteArrayOf(192.toByte(), 0, 2, 2), reply.copyOfRange(16, 20))
        assertEquals(53, u16(reply, 20))
        assertEquals(40_000, u16(reply, 22))
        assertEquals(reply.size, u16(reply, 2))
        assertEquals(reply.size - 20, u16(reply, 24))
        assertEquals("header checksum verifies", 0, DnsPacket.ipChecksum(reply, 20))
    }

    @Test
    fun `ignores what is not an IPv4 lookup`() {
        val query = hex(bbcQueryHex)
        val ok = ipv4Udp(byteArrayOf(192.toByte(), 0, 2, 2), byteArrayOf(192.toByte(), 0, 2, 1), 40_000, 53, query)
        assertFalse("IPv6", DnsPacket.isUdpDns(ok.copyOf().also { it[0] = 0x65 }))
        assertFalse("TCP", DnsPacket.isUdpDns(ok.copyOf().also { it[9] = 6 }))
        assertFalse("HTTPS port", DnsPacket.isUdpDns(ok.copyOf().also { it[22] = 0x01; it[23] = 0xBB.toByte() }))
        assertFalse("too short", DnsPacket.isUdpDns(ok.copyOf(20)))
        // IHL of 15 words claims a 60-byte header on a 28-byte packet.
        assertFalse("options past the end", DnsPacket.isUdpDns(ok.copyOf(28).also { it[0] = 0x4F }))
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun u16(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)

    private fun u32(b: ByteArray, o: Int) =
        ((b[o].toLong() and 0xFF) shl 24) or ((b[o + 1].toLong() and 0xFF) shl 16) or
            ((b[o + 2].toLong() and 0xFF) shl 8) or (b[o + 3].toLong() and 0xFF)

    /**
     * (type, ttl) for every resource record, read by a walker written separately
     * from the one under test, so a shared mistake cannot make both agree.
     */
    private fun records(dns: ByteArray): List<Pair<Int, Long>> {
        fun skip(o: Int): Int {
            var i = o
            while (true) {
                val len = dns[i].toInt() and 0xFF
                if (len == 0) return i + 1
                if (len >= 0xC0) return i + 2
                i += len + 1
            }
        }
        var i = 12
        repeat(u16(dns, 4)) { i = skip(i) + 4 }
        val out = mutableListOf<Pair<Int, Long>>()
        repeat(u16(dns, 6) + u16(dns, 8) + u16(dns, 10)) {
            i = skip(i)
            out += u16(dns, i) to u32(dns, i + 4)
            i += 10 + u16(dns, i + 8)
        }
        return out
    }

    private fun ipv4Udp(src: ByteArray, dst: ByteArray, srcPort: Int, dstPort: Int, payload: ByteArray): ByteArray {
        val total = 28 + payload.size
        val p = ByteArray(total)
        p[0] = 0x45; p[2] = (total shr 8).toByte(); p[3] = total.toByte()
        p[6] = 0x40; p[8] = 64; p[9] = 17
        System.arraycopy(src, 0, p, 12, 4)
        System.arraycopy(dst, 0, p, 16, 4)
        val csum = DnsPacket.ipChecksum(p, 20)
        p[10] = (csum shr 8).toByte(); p[11] = csum.toByte()
        p[20] = (srcPort shr 8).toByte(); p[21] = srcPort.toByte()
        p[22] = (dstPort shr 8).toByte(); p[23] = dstPort.toByte()
        val udpLen = 8 + payload.size
        p[24] = (udpLen shr 8).toByte(); p[25] = udpLen.toByte()
        System.arraycopy(payload, 0, p, 28, payload.size)
        return p
    }
}
