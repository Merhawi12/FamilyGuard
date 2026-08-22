import os from 'node:os';
import { foreground } from './foreground.js';
import { apps } from './processes.js';
import { dns, configureDnsBackup } from './dns.js';
import { permissions } from './permissions.js';

/**
 * The macOS half of the platform contract.
 *
 * Four capabilities and two labels, exactly mirroring `windows/src/platform`.
 * Everything else — the windows, the tray, the encrypted store, notifications,
 * autostart, the agent itself — is in `@parentix/child-desktop-shared`.
 */

/**
 * "macOS 14.5 (Darwin 23.5.0)".
 *
 * `os.release()` is the Darwin kernel version — `23.5.0` — which is not a thing
 * a parent has ever seen written on their child's laptop. `os.version()` gives
 * the marketing string when the runtime has one, and the kernel version stays
 * because it is what a support conversation actually needs.
 */
function osVersion() {
  const release = os.release();
  const version = os.version?.() || '';
  return version ? `${version} (Darwin ${release})` : `macOS (Darwin ${release})`;
}

export function createMacosPlatform({ dataDir }) {
  configureDnsBackup(dataDir);

  return {
    id: 'darwin',
    osVersion,
    deviceLabel: () => `${os.hostname().replace(/\.local$/, '')} · Mac`,
    foreground,
    apps,
    dns,
    permissions,
  };
}
