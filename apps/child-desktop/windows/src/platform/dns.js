import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ps, psJson } from './powershell.js';
import { isElevated } from './processes.js';

/**
 * Pointing Windows at the agent's own resolver, and — the part that matters —
 * putting it back.
 *
 * A machine whose DNS servers are `127.0.0.1` with nothing listening there has
 * no working internet at all, and nothing on screen would explain why. So the
 * original settings are written to a plain JSON file **outside** the encrypted
 * store, on purpose: this is the file a support call reads out over the phone,
 * and a parent should be able to open it in Notepad and see exactly what their
 * machine used to be set to.
 *
 * Two Windows-specific details that a naive implementation gets wrong:
 *
 * **DHCP and static are not the same restore.** `-ResetServerAddresses` puts an
 * interface back to whatever DHCP offers, which is right for the common case and
 * silently wrong for a household that has set its own resolver — that setting
 * would be gone, replaced by the ISP's, and nobody would connect the change to a
 * parental control. So which of the two it was is recorded per interface.
 *
 * **The resolver cache has to be cleared on both edges.** Windows caches
 * answers, so without a flush the sites the child visited in the minute before
 * filtering started stay reachable, and the NXDOMAINs the filter produced stay
 * *un*reachable for their TTL after it stops.
 */

/** Interfaces that are never redirected: the loopback is where we already are. */
const SKIP_ALIAS = /^(Loopback|isatap|Teredo)/i;

let _backupPath = null;

/** Set once by the platform module, which owns where per-user state lives. */
export function configureDnsBackup(dataDir) {
  _backupPath = path.join(dataDir, 'dns-backup.json');
}

const readBackup = async () => {
  try {
    return JSON.parse(await fs.readFile(_backupPath, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Every connected interface, with the resolvers it is using now.
 *
 * Read before anything is changed. Reading it afterwards returns `127.0.0.1` —
 * which is how a proxy ends up forwarding to itself and answering nothing.
 */
async function readInterfaces() {
  const result = await psJson(`
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
foreach ($ifc in Get-NetIPInterface -AddressFamily IPv4 -ConnectionState Connected) {
    if ($ifc.InterfaceAlias -match '^(Loopback|isatap|Teredo)') { continue }
    $v4 = @((Get-DnsClientServerAddress -InterfaceIndex $ifc.InterfaceIndex -AddressFamily IPv4).ServerAddresses)
    $v6 = @((Get-DnsClientServerAddress -InterfaceIndex $ifc.InterfaceIndex -AddressFamily IPv6).ServerAddresses)
    $rows += [pscustomobject]@{
        index = [int]$ifc.InterfaceIndex
        alias = [string]$ifc.InterfaceAlias
        dhcp  = ($ifc.Dhcp -eq 'Enabled')
        dns4  = $v4
        dns6  = $v6
    }
}
ConvertTo-Json -Compress -Depth 5 -InputObject @{ interfaces = @($rows) }
`, { interfaces: [] });

  const list = result?.interfaces;
  // PowerShell collapses a one-element array on the way out often enough that
  // this is not defensive programming, it is the single-interface laptop.
  const rows = Array.isArray(list) ? list : (list ? [list] : []);
  return rows.filter((row) => row?.index && !SKIP_ALIAS.test(row.alias || ''));
}

export const dns = {
  supported: true,

  canConfigure: isElevated,

  async upstreams() {
    const interfaces = await readInterfaces();
    const servers = new Set();
    for (const row of interfaces) {
      for (const address of [].concat(row.dns4 || [], row.dns6 || [])) servers.add(address);
    }
    return [...servers];
  },

  /**
   * Redirect the machine at the local resolver.
   *
   * The backup is written **before** the change, and a failure to write it stops
   * the change: an un-recorded redirect is the one outcome that has no route
   * back.
   */
  async apply({ ipv6 = false } = {}) {
    const interfaces = await readInterfaces();
    if (interfaces.length === 0) return false;

    await fs.writeFile(
      _backupPath,
      JSON.stringify({ at: new Date().toISOString(), interfaces }, null, 2),
      'utf8',
    );

    // '::1' only when something is actually answering there. Redirecting the
    // IPv6 resolver to an address with nothing behind it is how a filter takes a
    // machine off the network instead of filtering it.
    const addresses = ipv6 ? "'127.0.0.1','::1'" : "'127.0.0.1'";
    const indexes = interfaces.map((row) => row.index).join(',');

    await ps(`
$ErrorActionPreference = 'Stop'
foreach ($index in @(${indexes})) {
    Set-DnsClientServerAddress -InterfaceIndex $index -ServerAddresses (${addresses})
}
Clear-DnsClientCache
`);
    return true;
  },

  /**
   * Put every interface back.
   *
   * Safe to call when there is nothing to restore, and safe to call twice —
   * both of which matter, because it runs from the quit handler, from the
   * unlink handler, and from the next startup after a crash.
   */
  async restore() {
    const backup = await readBackup();
    if (!backup?.interfaces?.length) return false;

    for (const row of backup.interfaces) {
      const statics = [].concat(row.dns4 || [], row.dns6 || [])
        .filter((address) => address && address !== '127.0.0.1' && address !== '::1');

      const command = row.dhcp || statics.length === 0
        ? `Set-DnsClientServerAddress -InterfaceIndex ${Number(row.index)} -ResetServerAddresses`
        : `Set-DnsClientServerAddress -InterfaceIndex ${Number(row.index)} -ServerAddresses (${
          statics.map((address) => `'${String(address).replace(/[^0-9a-f.:]/gi, '')}'`).join(',')})`;

      try {
        await ps(`$ErrorActionPreference = 'Stop'\n${command}`);
      } catch (err) {
        // One interface failing must not strand the rest. A docking station that
        // has been unplugged since the redirect is the ordinary case, and its
        // index no longer exists.
        console.warn(`[dns] could not restore interface ${row.index}:`, err.message);
      }
    }

    await ps('Clear-DnsClientCache').catch(() => {});
    await fs.unlink(_backupPath).catch(() => {});
    return true;
  },
};

export const __testing = { readInterfaces, readBackup };
