import { emitEvent } from './rules';
import { onUnlinked } from './link';
import { readJson, writeJson, removeJson } from './secureCache';

/**
 * Telling the parent when a child starts using an app this phone has not seen.
 *
 * `app_installed` was in the platform's alert catalogue, listed in the console
 * as one of its rules, and raised by nothing: the server's
 * `alert:app_installed` handler waited on an event the device has never sent.
 * The obvious way to send it — a `PACKAGE_ADDED` receiver — is new Kotlin on a
 * surface that cannot be verified without a handset.
 *
 * It is not needed. The usage sync already reports, every fifteen minutes, every
 * package the child has actually opened today. Remembering the set and
 * announcing what is new answers the question a parent is really asking, and
 * answers it *better* than an install would: an app installed and never opened
 * is not a thing anyone needs waking up for, and an app that came with the phone
 * and is opened for the first time today is. The alert is labelled for what it
 * detects — "New app used" — rather than for the mechanism that was planned.
 *
 * Three things this has to get right, and each one is a way it could be worse
 * than nothing:
 *
 * **The first sync must be silent.** Every app is new to a phone that has just
 * been linked, so announcing them would greet a parent with forty alerts in the
 * first quarter hour of owning the product. The first observation seeds the
 * baseline and says nothing.
 *
 * **It must survive a restart.** Held only in memory, the baseline would reset
 * on every app launch and re-announce the child's whole phone. It is cached in
 * SecureStore beside the rules and the contact list.
 *
 * **It must be capped.** A phone restored from a backup, or one whose usage
 * permission is granted long after linking, can reveal a large set at once. Past
 * the cap the parent is told the count rather than handed a page of alerts.
 */

const CACHE_KEY = 'fg_known_packages';

/** Past this many new apps in one sync, report the number instead of each one. */
const MAX_ALERTS_PER_SYNC = 3;

const _state = {
  /** null until the cache has been read — distinct from "read, and empty". */
  known: null,
};

/**
 * A new link is a new child. The previous holder's apps are not this one's
 * baseline, and keeping them would silence the first thing the new child opened.
 */
onUnlinked(() => {
  _state.known = null;
  removeJson(CACHE_KEY).catch(() => {});
});

/** Load the baseline from disk once, so a restart does not re-announce a phone. */
async function loadKnown() {
  if (_state.known) return _state.known;
  const cached = await readJson(CACHE_KEY, null);
  _state.known = new Set(Array.isArray(cached) ? cached : []);
  // `seeded` distinguishes "no cache yet" from "a cache that happens to be
  // empty": only the former may pass silently.
  _state.known.seeded = Array.isArray(cached);
  return _state.known;
}

/**
 * Compare this sync's packages against everything seen before, announce what is
 * new, and remember it.
 *
 * @param packages  the package names reported by this usage sync
 * @param appNames  `{ [packageName]: label }`, so the alert can name the app
 * @returns the packages announced, for the tests and the logs
 */
export async function reportNewApps(packages, appNames = {}) {
  /**
   * A sync that saw nothing tells us nothing.
   *
   * `syncUsageStats` runs at startup, and on a phone where usage access has not
   * been granted yet — which is every phone, for the minutes between linking and
   * the child working through the Permissions screen — it reports an empty set.
   * Treating that as the baseline would mean the *next* sync, the first one that
   * can actually see the phone, announces every app on it. Seeding waits for a
   * sync with something in it.
   */
  if (packages.length === 0) return [];

  const known = await loadKnown();
  const fresh = packages.filter((pkg) => !known.has(pkg));

  for (const pkg of packages) known.add(pkg);
  // The Set carries a `seeded` flag, which does not survive JSON — spread it
  // back to a plain array first.
  await writeJson(CACHE_KEY, [...known]).catch(() => {});

  // The first observation on this link is the baseline, never news.
  if (!known.seeded) {
    known.seeded = true;
    return [];
  }
  if (fresh.length === 0) return [];

  const named = fresh.slice(0, MAX_ALERTS_PER_SYNC);
  for (const pkg of named) {
    emitEvent('alert:app_installed', { appName: appNames[pkg] || pkg, appPackage: pkg });
  }

  if (fresh.length > named.length) {
    const rest = fresh.length - named.length;
    emitEvent('alert:app_installed', {
      appName: `${rest} more app${rest === 1 ? '' : 's'}`,
      appPackage: null,
    });
  }

  return fresh;
}

/** Test seam: forget the in-memory baseline without touching the cache. */
export function resetNewAppsState() {
  _state.known = null;
}
