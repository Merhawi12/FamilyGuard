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

/**
 * One write at a time per key.
 *
 * Every writer in this agent is the same process and several of them are
 * fire-and-forget on a timer — `persist()` in screenTime.js, `persistQueue()` in
 * webHistory.js — so two writes of one key overlapping is ordinary, not
 * exotic. Unserialised, that is broken on both halves of the atomic write:
 *
 *   - the temp path was `<target>.<pid>.tmp`, unique between processes and not
 *     within one, so both writers opened the *same* file and interleaved their
 *     bytes into it;
 *   - and giving each write its own temp name only moves the problem to the
 *     rename, where two `MoveFileEx(REPLACE_EXISTING)` calls onto one target
 *     race — which on Windows surfaces as `EPERM`, observed in the desktop
 *     harness as a dropped web-history queue write.
 *
 * A chain per key fixes both, and is the only thing that can: the last writer
 * wins, having seen the whole of the previous write land. `readJson` therefore
 * never sees a half-written file, which for the rules cache is the difference
 * between a laptop coming up enforcing yesterday's rules and one coming up
 * believing nothing is blocked.
 *
 * The map is keyed by the *file*, so two different keys still write in parallel.
 * Entries are dropped once the chain settles, so it cannot grow.
 */
const _writes = new Map();

let _writeSeq = 0;

const serialize = (file, work) => {
  const previous = _writes.get(file) || Promise.resolve();
  // `.catch` before chaining: one failed write must not poison every write of
  // that key afterwards.
  const next = previous.catch(() => {}).then(work);
  _writes.set(file, next);
  next.catch(() => {}).finally(() => {
    if (_writes.get(file) === next) _writes.delete(file);
  });
  return next;
};

export function setItem(key, value) {
  const target = fileFor(key);
  return serialize(target, async () => {
    await ensureDir();
    const sealed = platform().secureStorage.encrypt(String(value));
    _writeSeq += 1;
    const temp = `${target}.${process.pid}.${_writeSeq}.tmp`;
    try {
      await fs.writeFile(temp, sealed, { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (err) {
      // A failed write must not leave its partial temp file behind: this
      // directory is written to for the life of the agent and nothing else ever
      // removes them.
      await fs.unlink(temp).catch(() => {});
      throw err;
    }
  });
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

/**
 * On the same chain as `setItem`, and that is not tidiness.
 *
 * Unlinking is what happens when the parent removes this computer, and the
 * writers above run on timers. An unlink that overtook a write already in
 * flight would be followed by that write's `rename`, putting the file back —
 * so an unlinked machine would come up still holding the credential, the rules
 * cache or the web-history backlog it was supposed to have forgotten. The e2e
 * asserts all three are gone.
 */
export function removeItem(key) {
  const target = fileFor(key);
  return serialize(target, async () => {
    try {
      await fs.unlink(target);
    } catch { /* already gone */ }
  });
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
