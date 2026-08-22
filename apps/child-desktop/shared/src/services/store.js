import { promises as fs } from 'node:fs';
import path from 'node:path';
import { platform } from '../platform/index.js';

/**
 * Where the agent keeps what has to survive a restart: the device credential,
 * the last rules it downloaded, the approved-contact list, the web-history
 * backlog and the set of apps it has seen before.
 *
 * This is the desktop counterpart of the mobile app's SecureStore wrapper, and
 * it exists for the same reason that one does: a device that comes up with no
 * network must still enforce the rules it was last given. A parental control
 * that switches itself off when the laptop is offline is worse than none,
 * because the parent is still being told it is on.
 *
 * Two differences from the phone, both because a filesystem is not a keystore:
 *
 * **Everything is encrypted through the OS.** `platform().secureStorage` is
 * Electron's `safeStorage` — DPAPI on Windows, the login Keychain on macOS — so
 * a file copied off the machine is not a usable device token. There is no
 * 2048-byte ceiling to work around here, so the chunking the phone needs is
 * gone.
 *
 * **Writes are atomic.** A file is written beside its target and renamed over
 * it. A half-written rules cache read back after a power cut is exactly the
 * situation in which the agent must not conclude that nothing is blocked.
 */

const DIR = () => path.join(platform().dataDir(), 'state');

/** Filenames come from our own constants, but never build a path from input. */
const fileFor = (key) => path.join(DIR(), `${String(key).replace(/[^a-z0-9_-]/gi, '_')}.bin`);

async function ensureDir() {
  // 0700: this directory holds a credential that authenticates as the child.
  await fs.mkdir(DIR(), { recursive: true, mode: 0o700 });
}

export async function setItem(key, value) {
  await ensureDir();
  const sealed = platform().secureStorage.encrypt(String(value));
  const target = fileFor(key);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, sealed, { mode: 0o600 });
  await fs.rename(temp, target);
}

export async function getItem(key) {
  try {
    const sealed = await fs.readFile(fileFor(key));
    return platform().secureStorage.decrypt(sealed);
  } catch {
    // Absent, unreadable, or sealed by a different user account — all of which
    // mean the same thing to every caller: there is no value here.
    return null;
  }
}

export async function removeItem(key) {
  try {
    await fs.unlink(fileFor(key));
  } catch { /* already gone */ }
}

export async function readJson(key, fallback = null) {
  const raw = await getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  return setItem(key, JSON.stringify(value));
}

export const removeJson = removeItem;
