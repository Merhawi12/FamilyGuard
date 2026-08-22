import { emitEvent } from './rules.js';
import { onUnlinked } from './link.js';
import { readJson, writeJson, removeJson } from './store.js';

/**
 * Telling the parent when a child starts using an application this computer has
 * not seen before.
 *
 * The same answer the mobile app arrived at, for the same reason: watching for
 * an *install* means one mechanism per platform and misses the case that
 * actually matters, while the usage measurement already knows, every few
 * seconds, exactly which applications the child opens. An app installed and
 * never opened is not news; a game that came with the laptop and is opened for
 * the first time today is.
 *
 * Three things this has to get right, and each is a way it could be worse than
 * nothing:
 *
 * **The first observation must be silent.** Everything is new to a machine that
 * has just been linked, and a parent should not be greeted by an alert for every
 * application on their child's laptop in the first quarter hour of owning the
 * product.
 *
 * **It must survive a restart.** Held in memory, the baseline would reset on
 * every launch and re-announce the whole machine.
 *
 * **It must be capped.** A new link on a well-used laptop can reveal a large set
 * at once. Past the cap the parent is told the count rather than handed a page
 * of alerts.
 */

const CACHE_KEY = 'fg_known_apps';

/** Past this many new apps in one pass, report the number instead of each one. */
const MAX_ALERTS_PER_PASS = 3;

const _state = {
  /** null until the cache has been read — distinct from "read, and empty". */
  known: null,
};

/** A new link is a new child; the previous holder's apps are not their baseline. */
onUnlinked(() => {
  _state.known = null;
  removeJson(CACHE_KEY).catch(() => {});
});

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
 * Compare this pass's applications against everything seen before, announce what
 * is new, and remember it.
 *
 * @param {string[]} appIds   the identifiers this pass observed
 * @param {object} appNames   `{ [appId]: label }`, so the alert can name the app
 * @returns the apps announced, for the tests and the logs
 */
export async function reportNewApps(appIds, appNames = {}) {
  /**
   * A pass that saw nothing tells us nothing.
   *
   * On a machine where the foreground capability has not been granted yet —
   * which is every Mac, for the minutes between linking and the child working
   * through the permissions window — this reports an empty set. Treating that as
   * the baseline would mean the *next* pass, the first one that can actually see
   * the machine, announces everything on it.
   */
  if (!appIds?.length) return [];

  const known = await loadKnown();
  const fresh = appIds.filter((id) => !known.has(id));

  for (const id of appIds) known.add(id);
  // The Set carries a `seeded` flag, which does not survive JSON — spread it
  // back to a plain array first.
  await writeJson(CACHE_KEY, [...known]).catch(() => {});

  if (!known.seeded) {
    known.seeded = true;
    return [];
  }
  if (fresh.length === 0) return [];

  const named = fresh.slice(0, MAX_ALERTS_PER_PASS);
  for (const id of named) {
    emitEvent('alert:app_installed', { appName: appNames[id] || id, appPackage: id });
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
