import dgram from 'node:dgram';
import { parseQuery, refuse, setId, TYPE_A, TYPE_AAAA, TYPE_HTTPS } from './wire.js';

/**
 * A local DNS resolver: the one mechanism behind both website blocking and the
 * parent's Web History screen.
 *
 * This is the desktop shape of what the Android app does with `VpnService`. The
 * machine's resolver is pointed at 127.0.0.1, every lookup arrives here, a
 * blocked name is answered NXDOMAIN and everything else is relayed to whichever
 * resolver the machine was using before — so nothing is sent to a third party
 * that was not already going there, and no traffic is inspected. What the agent
 * learns is the set of names that were looked up, which is exactly what the API
 * accepts: domains, no paths, no query strings.
 *
 * Two things make this the right layer to work at, and one thing makes it
 * imperfect:
 *
 * - It is browser-agnostic. Chrome, Edge, Firefox, Safari, an Electron game
 *   launcher and a command-line tool all resolve names the same way. Reading
 *   browser history databases would need one implementation per browser, would
 *   miss anything else on the machine, and would break every time a vendor
 *   changed a schema.
 * - It needs no native code and no kernel extension. A UDP socket is a UDP
 *   socket on both platforms.
 * - **DNS-over-HTTPS goes around it.** A browser that resolves names over its
 *   own HTTPS connection never asks this proxy anything. That is handled rather
 *   than ignored — see `DOH_HOSTS` and the Firefox canary below — but it is a
 *   negotiation with browser vendors, not a guarantee.
 */

/**
 * Where lookups go when we could not read the machine's own resolvers.
 *
 * Not merely a nicety for an odd network. The case that matters is a restore
 * that failed: the machine is still pointed at `127.0.0.1`, so reading its
 * resolvers returns our own address, which `setUpstreams` then filters out — and
 * a proxy with no upstream answers nothing at all. Falling back to a public
 * resolver keeps a filtered, working internet rather than a dead one, which is
 * the right way round for a laptop a child is sitting in front of.
 */
const FALLBACK_UPSTREAMS = ['1.1.1.1', '8.8.8.8'];

/** A relayed lookup this long unanswered is dropped; the client will retry. */
const UPSTREAM_TIMEOUT_MS = 5000;

/** Ceiling on lookups in flight, so a broken upstream cannot grow the map. */
const MAX_INFLIGHT = 2048;

/**
 * The name Firefox asks about before it turns DNS-over-HTTPS on.
 *
 * Answering NXDOMAIN is the documented way for a network to say "resolution here
 * is managed, do not bypass it", and Firefox honours it by falling back to the
 * system resolver. Without this, a Firefox install would silently stop appearing
 * in web history at all and stop being filtered, with nothing anywhere to
 * indicate it — the single most likely way for this feature to be quietly wrong.
 */
const FIREFOX_CANARY = 'use-application-dns.net';

/**
 * The endpoints browsers bootstrap DoH from.
 *
 * Refusing these names is not an attempt to block a protocol — a determined
 * client can hard-code an address — it is closing the ordinary path. A browser
 * that cannot resolve its DoH provider falls back to the system resolver, which
 * is this one, and the child's browsing is filtered and recorded as the parent
 * expects rather than invisibly exempt.
 */
const DOH_HOSTS = [
  'mozilla.cloudflare-dns.com',
  'chrome.cloudflare-dns.com',
  'cloudflare-dns.com',
  'dns.google',
  'dns.quad9.net',
  'doh.opendns.com',
  'dns.nextdns.io',
  'doh.cleanbrowsing.org',
  'dns.adguard.com',
  'dns.adguard-dns.com',
];

/** Query types that mean "somebody is opening this site". */
const BROWSING_TYPES = new Set([TYPE_A, TYPE_AAAA, TYPE_HTTPS]);

/**
 * Does `name` fall under `rule`?
 *
 * A parent blocking `example.com` means the site, not the single hostname, so a
 * rule matches the name itself and anything below it. The dot is what keeps
 * `notexample.com` out of a rule for `example.com`.
 */
export function matchesDomain(name, rule) {
  if (!name || !rule) return false;
  if (name === rule) return true;
  return name.endsWith(`.${rule}`);
}

export class DnsProxy {
  /**
   * @param {object} options
   * @param {boolean} [options.ipv6] also answer on `::1`.
   *
   * IPv6 is not optional cover on a modern home network — it is the hole. A
   * router that advertises an IPv6 resolver leaves the machine with a working
   * name service that never reaches this one, and the symptom is not an error:
   * it is a filter that appears to be running and quietly sees nothing. Both
   * families are redirected, so both have to be answered.
   */
  constructor({
    port = 53, address = '127.0.0.1', ipv6 = true, upstreamPort = 53, onVisits, flushIntervalMs = 30_000,
  } = {}) {
    this.port = port;
    this.address = address;
    this.ipv6 = ipv6;
    this.upstreamPort = upstreamPort;
    this.onVisits = onVisits;
    this.flushIntervalMs = flushIntervalMs;

    this.blocked = [];
    this.upstreams = [...FALLBACK_UPSTREAMS];

    this._servers = [];
    this._client = null;
    this._pending = new Map();
    this._nextId = 1;
    this._upstreamIndex = 0;
    this._flushTimer = null;
    /** domain → { domain, firstSeen, lastSeen, count, blocked } for this window. */
    this._window = new Map();

    this.stats = { queries: 0, refused: 0, relayed: 0, dropped: 0 };
  }

  /**
   * The domains to refuse.
   *
   * Replaced wholesale rather than merged, which is what makes a parent lifting
   * a rule take effect. The DoH endpoints are appended here rather than kept in
   * a separate list so there is one set to consult per lookup.
   */
  setBlockedDomains(domains) {
    const set = new Set([...(domains || [])]
      .map((d) => String(d || '').trim().toLowerCase().replace(/^\*?\.?/, '').replace(/\.$/, ''))
      .filter(Boolean));
    for (const host of DOH_HOSTS) set.add(host);
    this.blocked = [...set];
    return this.blocked;
  }

  /**
   * Where allowed lookups are forwarded.
   *
   * The filter is "would this point back at us", not "is this loopback". Reading
   * the machine's resolvers *after* redirecting them returns `127.0.0.1` — the
   * address we just wrote — and forwarding there is a proxy that asks itself and
   * answers nothing, which presents as a laptop with no internet rather than as
   * an error. Comparing the port as well as the address is what lets the test
   * harness run a real upstream on the loopback.
   */
  setUpstreams(list) {
    const pointsAtUs = (address) =>
      this.upstreamPort === this.port && (address.startsWith('127.') || address === '::1');

    const usable = (list || [])
      .map((s) => String(s || '').trim())
      .filter((s) => s && !pointsAtUs(s));

    this.upstreams = usable.length ? usable : [...FALLBACK_UPSTREAMS];
    return this.upstreams;
  }

  isBlocked(name) {
    return this.blocked.some((rule) => matchesDomain(name, rule));
  }

  _listen(type, address) {
    const socket = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
    socket.on('message', (msg, rinfo) => this._onQuery(msg, rinfo, socket));
    socket.on('error', (err) => console.warn(`[dns] ${type} listener error:`, err.message));

    return new Promise((resolve, reject) => {
      const fail = (err) => {
        socket.removeListener('listening', ok);
        // A socket that could not bind still holds a handle. Leaking one per
        // attempt matters here because a failed bind is the *expected* outcome
        // on an unelevated machine, and `startWebFilter` is retried on every
        // rules change.
        try { socket.close(); } catch { /* never bound */ }
        reject(err);
      };
      const ok = () => {
        socket.removeListener('error', fail);
        this._servers.push(socket);
        resolve(socket.address().port);
      };
      socket.once('error', fail);
      socket.once('listening', ok);
      socket.bind(this.port, address);
    });
  }

  async start() {
    if (this._servers.length) return this.port;

    this._client = dgram.createSocket('udp4');
    this._client.on('message', (msg) => this._onUpstreamReply(msg));
    this._client.on('error', (err) => console.warn('[dns] upstream socket error:', err.message));

    // IPv4 first, and its failure is fatal: with nothing listening there, the
    // machine must not be redirected at all. The upstream socket goes with it,
    // or an unelevated machine accumulates one per retry.
    let port;
    try {
      port = await this._listen('udp4', this.address);
    } catch (err) {
      try { this._client.close(); } catch { /* never bound */ }
      this._client = null;
      throw err;
    }

    if (this.ipv6) {
      // IPv6 is best-effort. A machine with the stack disabled cannot bind ::1,
      // and that is not a reason to run without a filter — it is a reason to run
      // without the half that has nothing to listen for.
      try {
        await this._listen('udp6', '::1');
      } catch (err) {
        console.warn('[dns] no IPv6 listener:', err.message);
      }
    }

    this._flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this._flushTimer.unref?.();

    return port;
  }

  /** True when `::1` is being answered, so the host knows whether to redirect it. */
  get hasIpv6() {
    return this._servers.some((s) => s.address().family === 'IPv6');
  }

  async stop() {
    clearInterval(this._flushTimer);
    this._flushTimer = null;
    this.flush();

    for (const entry of this._pending.values()) clearTimeout(entry.timer);
    this._pending.clear();

    const close = (socket) => new Promise((resolve) => {
      if (!socket) return resolve();
      try { socket.close(resolve); } catch { resolve(); }
    });
    await Promise.all([...this._servers.map(close), close(this._client)]);
    this._servers = [];
    this._client = null;
  }

  /** Hand the current window to the queue and start a new one. */
  flush() {
    if (this._window.size === 0) return [];
    const visits = [...this._window.values()];
    this._window.clear();
    try {
      this.onVisits?.(visits);
    } catch (err) {
      console.warn('[dns] visit handler failed:', err.message);
    }
    return visits;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _record(name, blocked) {
    const now = Date.now();
    const existing = this._window.get(name);
    if (existing) {
      existing.lastSeen = now;
      existing.count += 1;
      // Sticky, the same rule the server applies when it merges a visit: one
      // refused lookup in the window makes the whole visit a blocked attempt.
      existing.blocked = existing.blocked || blocked;
      return;
    }
    this._window.set(name, { domain: name, firstSeen: now, lastSeen: now, count: 1, blocked });
  }

  _onQuery(msg, rinfo, socket) {
    this.stats.queries += 1;
    const question = parseQuery(msg);

    // Not a standard query, or not one we can read. Relay it rather than guess.
    if (!question) return this._relay(msg, rinfo, socket);

    const { name, type } = question;

    /**
     * The canary is refused before anything else and regardless of the block
     * list: it is not a site anyone visits, and it is not history. Recording it
     * would put a hostname in the parent's Web History that the child never
     * typed.
     */
    if (name === FIREFOX_CANARY) {
      this.stats.refused += 1;
      return socket.send(refuse(msg, question), rinfo.port, rinfo.address);
    }

    const blocked = this.isBlocked(name);

    // Reverse lookups and service records are the machine talking to itself.
    if (BROWSING_TYPES.has(type) && !name.endsWith('.arpa') && name.includes('.')) {
      this._record(name, blocked);
    }

    if (blocked) {
      this.stats.refused += 1;
      return socket.send(refuse(msg, question), rinfo.port, rinfo.address);
    }

    return this._relay(msg, rinfo, socket, question.id);
  }

  _relay(msg, rinfo, socket, originalId = null) {
    if (this._pending.size >= MAX_INFLIGHT) {
      this.stats.dropped += 1;
      return;
    }

    // A local id, so two clients that happen to pick the same transaction id
    // cannot be handed each other's answers.
    let localId = this._nextId;
    for (let i = 0; i < 0x10000 && this._pending.has(localId); i += 1) {
      localId = (localId + 1) & 0xffff;
    }
    this._nextId = (localId + 1) & 0xffff;

    const forwarded = Buffer.from(msg);
    setId(forwarded, localId);

    const timer = setTimeout(() => {
      this._pending.delete(localId);
      this.stats.dropped += 1;
    }, UPSTREAM_TIMEOUT_MS);
    timer.unref?.();

    this._pending.set(localId, {
      originalId: originalId ?? msg.readUInt16BE(0),
      port: rinfo.port,
      address: rinfo.address,
      // The answer goes back over the socket the question arrived on. An IPv6
      // client cannot be answered from the IPv4 listener.
      socket,
      timer,
    });

    const upstream = this.upstreams[this._upstreamIndex % this.upstreams.length];
    this._upstreamIndex += 1;
    this._client.send(forwarded, this.upstreamPort, upstream, (err) => {
      if (!err) return;
      clearTimeout(timer);
      this._pending.delete(localId);
      this.stats.dropped += 1;
    });
  }

  _onUpstreamReply(msg) {
    if (msg.length < 2) return;
    const localId = msg.readUInt16BE(0);
    const entry = this._pending.get(localId);
    // An answer to a lookup that already timed out, or one nobody asked for.
    if (!entry) return;

    clearTimeout(entry.timer);
    this._pending.delete(localId);

    const reply = Buffer.from(msg);
    setId(reply, entry.originalId);
    this.stats.relayed += 1;
    entry.socket?.send(reply, entry.port, entry.address);
  }
}

export const __testing = { DOH_HOSTS, FIREFOX_CANARY };
