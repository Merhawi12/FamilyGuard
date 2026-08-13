import { device as deviceApi } from './api';
import { connectSocket, onSocket, emitSocket } from './socket';
import { onUnlinked } from './link';
import { readJson, writeJson } from './secureCache';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 min
const CACHE_KEY = 'fg_device_rules';

const EMPTY_RULES = { appRules: [], websiteRules: [], screenTimeRule: null };

let _rules = { ...EMPTY_RULES };
let _pollTimer = null;
let _onUpdate = null;
let _unsubscribers = [];
/**
 * Whether this phone is actually still talking to the parent's account.
 *
 * A failed sync was a `console.warn` and nothing else, so the device went on
 * showing every monitor as "On" and itself as "Linked" while its calls were
 * being refused — a suspended account, or simply a long stretch offline, looked
 * exactly like a healthy one. This is what the Settings screen reads to tell the
 * child the truth instead.
 */
let _sync = { lastSyncAt: null, lastError: null };

export function getRules() {
  return _rules;
}

export function getSyncStatus() {
  return _sync;
}

/**
 * An unlinked device enforces nobody's rules.
 *
 * `link.js` removes the cache from the keystore; this is the copy the blocker is
 * actually driven from. A handset moved from one sibling to the next would
 * otherwise spend the first moments of its new link applying the previous
 * child's blocks.
 */
onUnlinked(() => {
  _rules = { ...EMPTY_RULES };
  _sync = { lastSyncAt: null, lastError: null };
});

export async function fetchRules() {
  try {
    const res = await deviceApi.getRules();
    _rules = res.data;
    _sync = { lastSyncAt: new Date().toISOString(), lastError: null };
    // Persisted before it is applied, so a device killed mid-apply still comes
    // back holding the newest rules rather than the ones before them.
    await writeJson(CACHE_KEY, _rules).catch((err) => {
      console.warn('[rules] cache write failed:', err.message);
    });
    if (_onUpdate) await _onUpdate(_rules);
  } catch (e) {
    _sync = { ..._sync, lastError: e.message || 'Sync failed' };
    console.warn('[rules] fetch failed:', e.message);
  }
}

/**
 * Start keeping this device's rules current.
 *
 * The cached rules are applied *before* the first fetch, and that ordering is
 * the whole point. Rules used to live only in memory, so a device that started
 * with no network came up holding the empty default — and `refreshBlocking`,
 * which runs on a one-minute tick whether a sync succeeded or not, read that
 * empty set as "nothing is blocked" and pushed it to the native blocker, which
 * persists what it is given. Airplane mode and a restart lifted every app block
 * and bedtime until the network came back. A parental control that switches
 * itself off when the phone is offline is worse than none, because the parent
 * is still being told it is on.
 *
 * The same treatment `contacts.js` already gets, for the more important of the
 * two lists.
 */
export async function startRulesSync(onUpdate) {
  _onUpdate = onUpdate;

  const cached = await readJson(CACHE_KEY);
  if (cached && (cached.appRules || cached.websiteRules || cached.screenTimeRule)) {
    _rules = { ...EMPTY_RULES, ...cached };
    if (_onUpdate) await _onUpdate(_rules);
  }

  await fetchRules();

  // Poll as a safety net for a missed socket event or a long offline stretch.
  clearInterval(_pollTimer);
  _pollTimer = setInterval(fetchRules, POLL_INTERVAL);

  await connectSocket();

  _unsubscribers.push(onSocket('rules_updated', fetchRules));
  // A reconnect means the device may have missed a `rules_updated` while it was
  // away, and waiting out the rest of a five-minute poll is a long time to go on
  // enforcing a rule the parent has already lifted.
  _unsubscribers.push(onSocket('connect', fetchRules));
  _unsubscribers.push(onSocket('screen_time_updated', async (rule) => {
    _rules = { ..._rules, screenTimeRule: rule };
    await writeJson(CACHE_KEY, _rules).catch(() => {});
    if (_onUpdate) await _onUpdate(_rules);
  }));
}

/**
 * Emit a child-originated event on the authenticated device socket. The server
 * derives child/parent identity from the handshake, so callers never send ids.
 */
export function emitEvent(event, data = {}) {
  return emitSocket(event, data);
}

export function stopRulesSync() {
  clearInterval(_pollTimer);
  _pollTimer = null;
  _unsubscribers.forEach((off) => off());
  _unsubscribers = [];
  _onUpdate = null;
}
