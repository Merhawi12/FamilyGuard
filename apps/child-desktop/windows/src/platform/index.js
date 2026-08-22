import os from 'node:os';
import { foreground } from './foreground.js';
import { apps } from './processes.js';
import { dns, configureDnsBackup } from './dns.js';
import { permissions } from './permissions.js';

/**
 * The Windows half of the platform contract.
 *
 * Four capabilities and two labels. Everything else — the windows, the tray, the
 * encrypted store, notifications, autostart, the agent itself — is in
 * `@parentix/child-desktop-shared`, which is why this file is short and why a
 * behaviour change never lands here.
 */

/**
 * "Windows 11 Pro 10.0.26200".
 *
 * `os.release()` alone is `10.0.26200`, which is what the parent's device list
 * would show — a number that tells them nothing about the laptop in their house.
 * The edition comes from the same place the OS reports it and is worth the one
 * call: this string is how a parent tells two computers apart.
 */
function osVersion() {
  const release = os.release();
  const version = os.version?.() || '';
  // `os.version()` returns e.g. "Windows 11 Pro"; on a build where it does not,
  // the release number on its own is still better than nothing.
  return version ? `${version} ${release}` : `Windows ${release}`;
}

export function createWindowsPlatform({ dataDir }) {
  configureDnsBackup(dataDir);

  return {
    id: 'win32',
    osVersion,
    deviceLabel: () => `${os.hostname()} · Windows`,
    foreground,
    apps,
    dns,
    permissions,
  };
}
