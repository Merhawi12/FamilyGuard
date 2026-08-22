import { DnsProxy } from '../dns/proxy.js';
import { platform } from '../platform/index.js';
import { readJson, writeJson, removeJson } from './store.js';

/**
 * Website blocking and web history, as one thing, because on this platform they
 * genuinely are one thing: the local resolver decides what to refuse and is the
 * only part of the machine that sees what was looked up.
 *
 * The dangerous half of this feature is not the filtering — it is the system
 * setting. Pointing a machine's resolver at 127.0.0.1 and then dying takes the
 * whole computer off the internet, and a child cannot be expected to know that
 * `netsh` exists. Three things guard against it, and they are the reason this
 * module is bigger than the proxy it wraps:
 *
 * 1. **The proxy is listening before the machine is pointed at it**, and the
 *    machine is pointed back before the proxy closes. There is no window in
 *    which the resolver is 127.0.0.1 with nothing behind it.
 * 2. **The previous resolvers are written to disk before the change**, so a
 *    restore is possible from a cold start by a process that has no memory of
 *    what it replaced.
 * 3. **Startup repairs before it applies.** An agent that finds a backup on disk
 *    knows the last run did not shut down cleanly, and puts the machine back
 *    before doing anything else.
 */

const BACKUP_KEY = 'fg_dns_backup';

/**
 * Port 53 or nothing, in production.
 *
 * `netsh` and `networksetup` set a resolver *address*; neither can express a
 * port, so a proxy on 5353 would simply never be consulted. The override exists
 * for `scripts/e2e.mjs`, which runs the real proxy on a high port and never
 * touches the machine's settings.
 */
const PORT = Number(process.env.PARENTIX_DNS_PORT || 53);

/**
 * Where allowed lookups go. Also 53 in production — it is the port every
 * resolver in the world listens on — and settable only so the harness can run a
 * real upstream of its own on the loopback rather than reaching the internet.
 */
const UPSTREAM_PORT = Number(process.env.PARENTIX_DNS_UPSTREAM_PORT || 53);

const _state = {
  running: false,
  systemDnsApplied: false,
  port: PORT,
  upstreams: [],
  blockedCount: 0,
  lastError: null,
};

let _proxy = null;

export function getWebFilterStatus() {
  return { ..._state, stats: _proxy ? { ..._proxy.stats } : null };
}

/**
 * Undo a resolver change left behind by a run that did not stop cleanly.
 *
 * Called at startup before anything else touches DNS. Safe to call when there is
 * nothing to repair — the absence of a backup is the ordinary case.
 */
export async function repairSystemDns() {
  const backup = await readJson(BACKUP_KEY, null);
  if (!backup) return false;

  console.warn('[webFilter] a previous run left the system resolver redirected — restoring');
  try {
    await platform().dns.restore();
  } catch (err) {
    console.warn('[webFilter] restore failed:', err.message);
    // The backup is deliberately kept: a restore that failed must be retried on
    // the next start rather than forgotten because it was attempted once.
    return false;
  }
  await removeJson(BACKUP_KEY);
  return true;
}

/**
 * Start filtering.
 *
 * Returns a status object rather than throwing when the machine will not
 * cooperate. A laptop where the agent is not elevated cannot change the
 * resolver, and that is an answer the Settings window shows the child — not a
 * crash that takes screen-time monitoring down with it.
 */
export async function startWebFilter({ blockedDomains = [], onVisits } = {}) {
  const p = platform();
  if (!p.dns.supported) {
    _state.lastError = 'This computer cannot filter websites.';
    return getWebFilterStatus();
  }

  if (_proxy) {
    setBlockedDomains(blockedDomains);
    return getWebFilterStatus();
  }

  await repairSystemDns();

  // Read the resolvers *before* redirecting, or we read our own address back
  // and build a proxy that forwards to itself.
  const upstreams = await p.dns.upstreams().catch(() => []);

  _proxy = new DnsProxy({ port: PORT, upstreamPort: UPSTREAM_PORT, onVisits });
  _state.upstreams = _proxy.setUpstreams(upstreams);
  _state.blockedCount = _proxy.setBlockedDomains(blockedDomains).length;

  try {
    _state.port = await _proxy.start();
    _state.running = true;
    _state.lastError = null;
  } catch (err) {
    // EACCES on 53 without elevation, EADDRINUSE where another resolver already
    // holds it. Both are ordinary and neither is a reason to change DNS.
    _state.lastError = err.code === 'EACCES'
      ? 'Website filtering needs Parentix to run as an administrator.'
      : `Could not start the local resolver: ${err.message}`;
    _proxy = null;
    _state.running = false;
    return getWebFilterStatus();
  }

  // Only now — with something listening — is it safe to redirect the machine.
  if (PORT === 53 && await p.dns.canConfigure()) {
    await writeJson(BACKUP_KEY, { upstreams: _state.upstreams, at: new Date().toISOString() });
    try {
      // `ipv6` is whether `::1` is actually being answered. Redirecting the IPv6
      // resolver to an address with nothing behind it is how a filter takes a
      // machine off the network rather than filtering it.
      _state.systemDnsApplied = await p.dns.apply({ port: PORT, ipv6: _proxy.hasIpv6 });
    } catch (err) {
      _state.systemDnsApplied = false;
      _state.lastError = err.message;
    }
    if (!_state.systemDnsApplied) await removeJson(BACKUP_KEY);
  } else if (PORT === 53) {
    _state.lastError = 'Website filtering needs Parentix to run as an administrator.';
  }

  return getWebFilterStatus();
}

/** Replace the block list on a running filter. */
export function setBlockedDomains(domains) {
  if (!_proxy) return 0;
  _state.blockedCount = _proxy.setBlockedDomains(domains).length;
  return _state.blockedCount;
}

/** Hand whatever the current window holds to the web-history queue, now. */
export function flushVisits() {
  return _proxy ? _proxy.flush() : [];
}

export async function stopWebFilter() {
  // Order matters, and it is the reverse of start: the machine goes back to its
  // own resolvers first, and only then does this one stop answering.
  if (_state.systemDnsApplied) {
    try {
      await platform().dns.restore();
      await removeJson(BACKUP_KEY);
    } catch (err) {
      console.warn('[webFilter] could not restore the system resolver:', err.message);
    }
    _state.systemDnsApplied = false;
  }

  if (_proxy) {
    await _proxy.stop();
    _proxy = null;
  }
  _state.running = false;
  _state.blockedCount = 0;
}

export const __testing = { proxy: () => _proxy, BACKUP_KEY };
