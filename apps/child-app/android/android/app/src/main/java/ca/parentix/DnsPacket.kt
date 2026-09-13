package ca.parentix

/**
 * The DNS and IPv4/UDP byte handling behind `ParentixVpnService`.
 *
 * Kept free of Android imports on purpose. This is the part of website blocking
 * that is easiest to get subtly wrong and was the least tested — no test had
 * ever run a single line of it — and a plain object can be exercised on the JVM
 * against real packets captured from a public resolver. See `DnsPacketTest`.
 */
object DnsPacket {

    private const val HEADER = 12

    /** EDNS0. Its "TTL" field carries extended RCODE and flags, not a lifetime. */
    const val TYPE_OPT = 41

    /** Is this an IPv4 UDP packet addressed to port 53? */
    fun isUdpDns(p: ByteArray): Boolean {
        if (p.size < 28) return false
        if ((p[0].toInt() shr 4) != 4) return false
        if (p[9].toInt() and 0xFF != 17) return false
        val ihl = (p[0].toInt() and 0x0F) * 4
        // A header with options would otherwise index past a short packet and
        // throw on the worker thread, which is the thread doing the filtering.
        if (ihl < 20 || p.size < ihl + 8) return false
        return u16(p, ihl + 2) == 53
    }

    /** The DNS message inside an IPv4/UDP packet. */
    fun udpPayload(p: ByteArray): ByteArray? {
        val start = ((p[0].toInt() and 0x0F) * 4) + 8
        return if (p.size > start) p.copyOfRange(start, p.size) else null
    }

    /** The name in the first question, lowercased, or null if it cannot be read. */
    fun queryDomain(dns: ByteArray): String? {
        if (dns.size < HEADER) return null
        val sb = StringBuilder()
        var i = HEADER
        while (i < dns.size) {
            val len = dns[i].toInt() and 0xFF
            if (len == 0) break
            if (len and 0xC0 != 0) return null
            if (i + 1 + len > dns.size) return null
            if (sb.isNotEmpty()) sb.append('.')
            sb.append(String(dns, i + 1, len, Charsets.US_ASCII))
            i += 1 + len
        }
        return if (sb.isEmpty()) null else sb.toString().lowercase()
    }

    /** Offset just past the first question, or -1 if it cannot be read. */
    fun questionEnd(dns: ByteArray): Int {
        if (dns.size < HEADER) return -1
        val end = skipName(dns, HEADER)
        if (end < 0 || end + 4 > dns.size) return -1
        return end + 4 // QTYPE + QCLASS
    }

    /**
     * An NXDOMAIN carrying the question and nothing after it.
     *
     * It used to be the whole query with the counts zeroed, which left the
     * query's EDNS0 OPT record trailing behind a header announcing no additional
     * records — a message whose sections do not end where the packet does.
     */
    fun nxDomain(query: ByteArray): ByteArray {
        val end = questionEnd(query)
        val r = query.copyOf(if (end > 0) end else query.size)
        r[2] = (0x80 or (query[2].toInt() and 0x01)).toByte() // QR, keeping the query's RD
        r[3] = 0x83.toByte()                                  // RA, RCODE = NXDOMAIN
        for (k in 6..11) r[k] = 0
        return r
    }

    /**
     * Lower every record lifetime above [maxSeconds] to it, in place.
     *
     * This is what stops a site the parent has just blocked from going on
     * loading. Android's resolver answers a repeat lookup from its cache for as
     * long as the record said it could — and real records say hours: a CNAME for
     * `www.bbc.co.uk` came back with 21,468 seconds. Until that ran out, nothing
     * reached the filter to be refused. Capping the lifetime of every answer the
     * filter hands out bounds how long a stale "allowed" can outlive a new rule.
     *
     * The whole message is walked before a byte is changed, so anything that
     * cannot be read — truncated, a reserved label type, a length that overruns —
     * is returned exactly as it arrived. A resolution that works is worth more
     * than a lifetime this could not safely rewrite.
     *
     * OPT records are skipped: their TTL field is the extended RCODE and the
     * DNSSEC-OK flag, and "capping" it would corrupt both.
     */
    fun capTtls(dns: ByteArray, maxSeconds: Int): ByteArray {
        if (dns.size < HEADER) return dns
        val questions = u16(dns, 4)
        val records = u16(dns, 6) + u16(dns, 8) + u16(dns, 10)

        var i = HEADER
        repeat(questions) {
            i = skipName(dns, i)
            if (i < 0 || i + 4 > dns.size) return dns
            i += 4
        }

        val ttlOffsets = ArrayList<Int>(records)
        repeat(records) {
            i = skipName(dns, i)
            if (i < 0 || i + 10 > dns.size) return dns
            if (u16(dns, i) != TYPE_OPT) ttlOffsets.add(i + 4)
            i += 10 + u16(dns, i + 8)
            if (i > dns.size) return dns
        }

        val cap = maxSeconds.toLong()
        for (offset in ttlOffsets) {
            if (u32(dns, offset) > cap) putU32(dns, offset, cap)
        }
        return dns
    }

    /**
     * Is `name` a domain in `set`, or below one?
     *
     * Walks the name's own suffixes against a hash set rather than testing every
     * rule against the name — a category can expand to hundreds of domains and
     * this runs on every lookup the phone makes. Label boundaries are what make
     * it correct: `notexample.com` is not below `example.com`.
     */
    fun matches(name: String, set: Set<String>): Boolean {
        if (set.isEmpty()) return false
        var candidate = name.trimEnd('.').lowercase()
        while (candidate.isNotEmpty()) {
            if (candidate in set) return true
            val dot = candidate.indexOf('.')
            if (dot < 0) return false
            candidate = candidate.substring(dot + 1)
        }
        return false
    }

    /** Wrap [dns] as the IPv4/UDP reply to [request], addresses and ports swapped. */
    fun udpResponse(request: ByteArray, dns: ByteArray): ByteArray {
        val ihl = (request[0].toInt() and 0x0F) * 4
        val udpLen = 8 + dns.size
        val total = ihl + udpLen
        val p = ByteArray(total)
        p[0] = request[0]; p[1] = 0
        p[2] = ((total shr 8) and 0xFF).toByte(); p[3] = (total and 0xFF).toByte()
        p[4] = 0; p[5] = 0; p[6] = 0x40; p[7] = 0; p[8] = 64; p[9] = 17
        System.arraycopy(request, 16, p, 12, 4) // source ← request's destination
        System.arraycopy(request, 12, p, 16, 4) // destination ← request's source
        p[10] = 0; p[11] = 0
        val csum = ipChecksum(p, ihl)
        p[10] = ((csum shr 8) and 0xFF).toByte(); p[11] = (csum and 0xFF).toByte()
        p[ihl + 0] = request[ihl + 2]; p[ihl + 1] = request[ihl + 3] // ports swapped
        p[ihl + 2] = request[ihl + 0]; p[ihl + 3] = request[ihl + 1]
        p[ihl + 4] = ((udpLen shr 8) and 0xFF).toByte(); p[ihl + 5] = (udpLen and 0xFF).toByte()
        p[ihl + 6] = 0; p[ihl + 7] = 0 // no UDP checksum, which IPv4 permits
        System.arraycopy(dns, 0, p, ihl + 8, dns.size)
        return p
    }

    fun ipChecksum(h: ByteArray, len: Int): Int {
        var s = 0
        var i = 0
        while (i < len - 1) { s += u16(h, i); i += 2 }
        if (len % 2 != 0) s += (h[len - 1].toInt() and 0xFF) shl 8
        while (s shr 16 != 0) s = (s and 0xFFFF) + (s shr 16)
        return s.inv() and 0xFFFF
    }

    /** Offset past a name at [offset] — labels or a compression pointer — or -1. */
    private fun skipName(dns: ByteArray, offset: Int): Int {
        var i = offset
        while (i < dns.size) {
            val len = dns[i].toInt() and 0xFF
            when {
                len == 0 -> return i + 1
                len and 0xC0 == 0xC0 -> return if (i + 2 <= dns.size) i + 2 else -1
                len and 0xC0 != 0 -> return -1 // 0x40 / 0x80: reserved label types
                else -> i += 1 + len
            }
        }
        return -1
    }

    private fun u16(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)

    private fun u32(b: ByteArray, o: Int): Long =
        ((b[o].toLong() and 0xFF) shl 24) or ((b[o + 1].toLong() and 0xFF) shl 16) or
            ((b[o + 2].toLong() and 0xFF) shl 8) or (b[o + 3].toLong() and 0xFF)

    private fun putU32(b: ByteArray, o: Int, v: Long) {
        b[o] = ((v shr 24) and 0xFF).toByte()
        b[o + 1] = ((v shr 16) and 0xFF).toByte()
        b[o + 2] = ((v shr 8) and 0xFF).toByte()
        b[o + 3] = (v and 0xFF).toByte()
    }
}
