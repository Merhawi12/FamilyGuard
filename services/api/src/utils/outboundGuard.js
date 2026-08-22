const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');

/**
 * Keeping a caller-supplied URL from turning the API into a probe of its own
 * network.
 *
 * One request body on this service names a URL the server will then fetch: a Web
 * Push subscription. `POST /api/notifications/push/subscribe` takes
 * `{ endpoint, keys }` straight from the browser, stores it, and every alert
 * from then on — plus `POST /push/test`, which a parent can fire on demand —
 * makes the server POST to that endpoint. Nothing looked at it. An authenticated
 * parent could therefore register
 * `http://10.128.0.7:8080/admin/shutdown` and have Cloud Run deliver a POST to
 * it from inside the VPC, on a schedule of their choosing, for as long as the
 * subscription lived.
 *
 * It is a blind SSRF — the response never reaches the caller, and the body is
 * encrypted to keys the destination does not hold — which is why this is a
 * hardening fix rather than an emergency. But "blind" bounds what can be read,
 * not what can be reached: Cloud Run sits in a VPC with the database, the
 * metadata server and whatever else is on private IP, and a POST is not a safe
 * verb to hand a stranger against an unknown internal service.
 *
 * Two layers, because either alone is defeatable:
 *
 *   `assertPublicHttpsUrl`  at registration. Refuses anything that is not
 *                           https, and anything naming an IP literal or an
 *                           obviously-internal name. This is the check that
 *                           produces a 400 the client can act on.
 *
 *   `guardedAgent`          at send time. The hostname is re-checked *after*
 *                           DNS resolves, which is the only place a name that
 *                           points at 169.254.169.254 can be caught — the
 *                           registration check sees `push.example.com` and has
 *                           no way to know. It also closes the gap between the
 *                           two, where a name that resolved publicly on Tuesday
 *                           resolves privately on Wednesday.
 */

/** Names that are internal by definition, whatever they resolve to. */
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localdomain', '.localhost'];
const BLOCKED_HOSTS = ['localhost', 'metadata', 'metadata.google.internal'];

const ipv4InRange = (ip, prefix, bits) => {
  const toInt = (value) => value.split('.').reduce((acc, part) => (acc << 8n) + BigInt(part), 0n);
  const mask = (0xffffffffn >> BigInt(32 - bits)) << BigInt(32 - bits);
  return (toInt(ip) & mask) === (toInt(prefix) & mask);
};

/**
 * Everything that is not a public unicast destination.
 *
 * Broader than "private": link-local carries the cloud metadata server,
 * carrier-grade NAT and the benchmarking range sit inside provider networks,
 * and multicast/reserved space is never a push service. A push endpoint is
 * always a named host on the public internet, so refusing all of this costs
 * nothing real.
 */
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const isPrivateIp = (address) => {
  const ip = String(address || '').trim();
  if (!ip) return true;

  if (net.isIPv4(ip)) return PRIVATE_V4.some(([prefix, bits]) => ipv4InRange(ip, prefix, bits));

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    // An IPv4-mapped or IPv4-compatible address is an IPv4 destination wearing a
    // v6 hat — `::ffff:169.254.169.254` reaches the metadata server exactly as
    // the bare form does, and checking only the textual v6 ranges would miss it.
    const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embedded) return isPrivateIp(embedded[1]);
    if (lower === '::' || lower === '::1') return true;
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    return /^(f[cd]|fe[89ab]|ff)/i.test(lower);
  }

  // Not an address this process can classify. Refuse rather than guess.
  return true;
};

/**
 * Whether a URL is a plausible public HTTPS destination.
 *
 * @returns {string|null} why it was refused, or null if it is acceptable.
 */
const publicHttpsProblem = (value) => {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return 'endpoint is not a valid URL';
  }

  // Plain HTTP would send the push service's own auth headers over the wire in
  // the clear, and is also how an internal destination is usually reached.
  if (url.protocol !== 'https:') return 'endpoint must be an https:// URL';

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'endpoint has no host';
  if (BLOCKED_HOSTS.includes(host)) return 'endpoint names an internal host';
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'endpoint names an internal host';

  // A real push service is always a DNS name. An IP literal is either an
  // internal target or someone routing around the name check, so both go.
  if (net.isIP(host)) return 'endpoint must name a host, not an IP address';

  return null;
};

/** Throws a 400-shaped error when the URL is not a public HTTPS destination. */
const assertPublicHttpsUrl = (value, label = 'endpoint') => {
  const problem = publicHttpsProblem(value);
  if (problem) throw Object.assign(new Error(problem.replace('endpoint', label)), { status: 400 });
};

/**
 * A DNS lookup that refuses to hand back an address inside the network.
 *
 * Node calls this with `{ all: true }` when happy-eyeballs is on and with
 * `{ all: false }` otherwise, and the two return completely different shapes —
 * an array of `{ address, family }` versus three positional arguments. Both are
 * handled, because getting it wrong on the branch that is not exercised locally
 * is how a guard ends up disabled in production only.
 */
const guardedLookup = (hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options;

  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return done(err);

    const allowed = addresses.filter((entry) => !isPrivateIp(entry.address));
    if (allowed.length === 0) {
      return done(Object.assign(
        new Error(`Refusing to connect to ${hostname}: it resolves inside the private network`),
        { code: 'EBLOCKEDADDRESS' }
      ));
    }

    if (opts.all) return done(null, allowed);
    return done(null, allowed[0].address, allowed[0].family);
  });
};

/**
 * The agent every outbound call to a caller-named URL goes through.
 *
 * One instance, so connections are pooled: a fresh agent per notification would
 * mean a fresh TLS handshake per notification.
 */
const guardedAgent = new https.Agent({ keepAlive: true, lookup: guardedLookup });

module.exports = {
  assertPublicHttpsUrl,
  publicHttpsProblem,
  guardedAgent,
  guardedLookup,
  isPrivateIp,
};
