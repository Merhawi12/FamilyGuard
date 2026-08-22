import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run, tryRun } from './shell.js';

/**
 * Pointing macOS at the agent's own resolver, and putting it back.
 *
 * `networksetup` is the supported way to change a network service's DNS servers
 * and it needs root. **The GUI agent is not root, and should not be** — an
 * Electron application running as root on a Mac is a much larger problem than
 * the one it would solve. So the privileged half is a fourteen-line shell script
 * that launchd runs as a daemon (`build/launchd/`), and this module asks it by
 * writing a request file that launchd is watching.
 *
 * **The protocol has no addresses in it, and that is the security design.**
 * `/Users/Shared` is writable by every local account, so anything the helper
 * accepts, any user on the Mac can ask for. If the request carried a list of DNS
 * servers, a local user could point the machine's resolver anywhere they liked,
 * as root — a real local privilege escalation shipped inside a parental control.
 * Instead the helper takes exactly two instructions, `redirect` and `restore`,
 * and it is the helper that snapshots the current servers into a root-owned file
 * and reads them back. The worst a local user can do is switch Parentix's own
 * filter on or off, which is no more than quitting the app already gives them.
 *
 * When the helper is not installed, `canConfigure()` answers false, website
 * blocking and web history do not start, and the permissions window says so —
 * the same degradation as an unelevated Windows install, and stated rather than
 * hidden.
 */

/** The header line and disabled services `-listallnetworkservices` prints. */
const SKIP_LINE = /^(An asterisk|\*)/;

/**
 * A fixed location, not the per-user data directory.
 *
 * A LaunchDaemon plist is written once, at install time, and it has to name the
 * path it watches. `~/Library/Application Support` is a different path for every
 * account, so a daemon pointed at one child's copy would silently ignore the
 * other's. `/Users/Shared` exists on every Mac and is writable by all of them.
 */
const SHARED = '/Users/Shared/Parentix';
const REQUEST = path.join(SHARED, 'dns-request.json');
const RESULT = path.join(SHARED, 'dns-result.json');
const HELPER_PLIST = '/Library/LaunchDaemons/ca.parentix.child-desktop.helper.plist';

export function configureDnsBackup() {
  // Nothing to configure: the snapshot this platform restores from is the
  // helper's, and it lives beside the helper where a non-root process cannot
  // edit it. The signature is kept so both platform modules present the same
  // one to `createOs`.
}

/** Every enabled network service — Wi-Fi, Ethernet, a USB tether, a VPN. */
async function services() {
  const out = await tryRun('/usr/sbin/networksetup', ['-listallnetworkservices']);
  return out.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !SKIP_LINE.test(line));
}

/**
 * Ask the root helper to do something, and wait for its answer.
 *
 * launchd starts the helper on a change to the request file (`WatchPaths`), the
 * helper writes the result file, and this watches for it. A file handshake
 * rather than a socket because launchd already provides the trigger, and every
 * line of privileged code that does not have to exist is a line that cannot be
 * wrong.
 */
async function askHelper(action, extra = {}, { timeout = 20_000 } = {}) {
  const id = `${Date.now()}-${process.pid}`;
  await fs.mkdir(SHARED, { recursive: true }).catch(() => {});
  await fs.rm(RESULT, { force: true }).catch(() => {});
  await fs.writeFile(REQUEST, JSON.stringify({ id, action, ...extra }), 'utf8');

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await fs.readFile(RESULT, 'utf8'));
      if (result.id === id) return result;
    } catch { /* not written yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 250).unref?.(); });
  }
  throw new Error('The Parentix DNS helper did not answer.');
}

export const dns = {
  supported: true,

  /**
   * Root directly (a development run under `sudo`), or the helper installed.
   *
   * The plist is what is checked rather than the script: a script on disk that
   * launchd has not been told about will never run, and reporting the filter as
   * available on that basis is exactly the silent failure this flag exists to
   * prevent.
   */
  async canConfigure() {
    if (process.getuid?.() === 0) return true;
    try {
      await fs.access(HELPER_PLIST);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * The resolvers to forward to.
   *
   * `networksetup` answers "There aren't any DNS Servers set on Wi-Fi." rather
   * than printing nothing, and that sentence means "whatever DHCP said" — so it
   * contributes no upstream here and the proxy falls back to its defaults.
   */
  async upstreams() {
    const found = new Set();
    for (const service of await services()) {
      const out = await tryRun('/usr/sbin/networksetup', ['-getdnsservers', service]);
      for (const line of out.split('\n').map((l) => l.trim())) {
        if (line && /^[0-9a-f.:]+$/i.test(line)) found.add(line);
      }
    }
    return [...found];
  },

  async apply({ ipv6 = false } = {}) {
    if (process.getuid?.() === 0) return redirectDirectly({ ipv6 });
    const result = await askHelper('redirect', { ipv6: !!ipv6 });
    return !!result.ok;
  },

  async restore() {
    if (process.getuid?.() === 0) return restoreDirectly();
    try {
      const result = await askHelper('restore');
      return !!result.ok;
    } catch (err) {
      console.warn('[dns] restore failed:', err.message);
      return false;
    }
  },
};

// ── The same work, when the agent is already root ────────────────────────────
//
// A development run (`sudo npm start`) and the packaged app take different
// routes to the same two commands. Kept here rather than duplicated into the
// helper script so there is one description of what "redirect" means.

/**
 * What the resolvers were before the redirect.
 *
 * Tab-separated (`Wi-Fi\t1.1.1.1 8.8.8.8`, or `Wi-Fi\tEmpty` for DHCP) rather
 * than JSON, because the helper script writes and reads this file too and
 * parsing JSON in `/bin/sh` is a worse idea than reading a tab. Both halves
 * agree on the format; neither has to agree on a parser.
 */
const SNAPSHOT = path.join(SHARED, 'dns-snapshot.tsv');

const parseSnapshot = (text) => text.split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [service, servers = ''] = line.split('\t');
    return { service, servers: servers.trim() === 'Empty' ? [] : servers.trim().split(/\s+/).filter(Boolean) };
  });

async function flush() {
  await tryRun('/usr/bin/dscacheutil', ['-flushcache']);
  // Both, and in this order. Emptying the directory-services cache without
  // restarting the resolver that actually answers is the classic reason a DNS
  // change on a Mac "does not take".
  await tryRun('/usr/bin/killall', ['-HUP', 'mDNSResponder']);
}

async function redirectDirectly({ ipv6 }) {
  const list = await services();
  if (list.length === 0) return false;

  /**
   * An existing snapshot is never overwritten.
   *
   * Applying twice — a rules change, a network that came back — would otherwise
   * record `127.0.0.1` as what the machine "used to be set to", and the restore
   * would put it right back where it started with nothing left to recover.
   */
  let existing = null;
  try { existing = parseSnapshot(await fs.readFile(SNAPSHOT, 'utf8')); } catch { /* first run */ }

  if (!existing?.length) {
    const rows = [];
    for (const service of list) {
      const out = await tryRun('/usr/sbin/networksetup', ['-getdnsservers', service]);
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const servers = (lines.length === 0 || /aren't any/i.test(lines[0]))
        ? []
        : lines.filter((l) => /^[0-9a-f.:]+$/i.test(l) && l !== '127.0.0.1' && l !== '::1');
      rows.push(`${service}\t${servers.length ? servers.join(' ') : 'Empty'}`);
    }
    await fs.mkdir(SHARED, { recursive: true });
    await fs.writeFile(SNAPSHOT, `${rows.join('\n')}\n`, 'utf8');
  }

  const addresses = ipv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1'];
  for (const service of list) {
    try {
      await run('/usr/sbin/networksetup', ['-setdnsservers', service, ...addresses]);
    } catch (err) {
      console.warn(`[dns] could not set ${service}:`, err.message);
    }
  }
  await flush();
  return true;
}

async function restoreDirectly() {
  let snapshot;
  try {
    snapshot = parseSnapshot(await fs.readFile(SNAPSHOT, 'utf8'));
  } catch {
    return false;
  }
  if (!snapshot.length) return false;

  for (const { service, servers } of snapshot) {
    try {
      // `Empty` is `networksetup`'s word for "go back to what DHCP says".
      await run('/usr/sbin/networksetup', ['-setdnsservers', service, ...(servers.length ? servers : ['Empty'])]);
    } catch (err) {
      console.warn(`[dns] could not restore ${service}:`, err.message);
    }
  }
  await flush();
  await fs.rm(SNAPSHOT, { force: true }).catch(() => {});
  return true;
}

export const __testing = { services, redirectDirectly, restoreDirectly, SHARED, REQUEST, RESULT };
