import { device as deviceApi } from './api.js';
import { connectSocket, onSocket, emitSocket } from './socket.js';
import { onUnlinked } from './link.js';
import { readJson, writeJson } from './store.js';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 min
const CACHE_KEY = 'fg_device_rules';

// `blocked` is the parent's pause on *this* machine: `{ since, reason }` or
// null. It rides the rules payload and the rules cache deliberately — a laptop
// that was blocked and then started offline must come up locked, and the cache
// is the only thing that survives a restart with no network.
//
// `screenTimeGrants` is `[{ minutes, grantedAt }]`, the extra time a parent
// granted for today. It is cached for the opposite reason to `blocked` and is
// just as important: a laptop that goes offline after being given fifteen minutes
// must not take them back, and the timestamps are what let it work out for itself
// when they expire. See `bonusMinutesFrom` in schedule.js.
const EMPTY_RULES = {
  appRules: [], websiteRules: [], screenTimeRule: null, screenTimeGrants: [],
  childName: null, blocked: null,
};

let _rules = { ...EMPTY_RULES };
let _pollTimer = null;
let _onUpdate = null;
let _unsubscribers = [];
/**
 * Whether this machine is actually still talking to the parent's account.
 *
 * A failed sync is not a reason to show every monitor as "On": a suspended
 * account and a long stretch offline look exactly like a healthy device from the
 * inside. The Settings window reads this to tell the child the truth instead.
 */
let _sync = { lastSyncAt: null, lastError: null };

export function getRules() {
  return _rules;
}

export function getSyncStatus() {
  return _sync;
}

/** An unlinked device enforces nobody's rules. */
onUnlinked(() => {
  _rules = { ...EMPTY_RULES };
  _sync = { lastSyncAt: null, lastError: null };
});

export async function fetchRules() {
  try {
    const res = await deviceApi.getRules();
    _rules = { ...EMPTY_RULES, ...res.data };
    _sync = { lastSyncAt: new Date().toISOString(), lastError: null };
    // Persisted before it is applied, so an agent killed mid-apply comes back
    // holding the newest rules rather than the ones before them.
    await writeJson(CACHE_KEY, _rules).catch((err) => {
      console.warn('[rules] cache write failed:', err.message);
    });
    if (_onUpdate) await _onUpdate(_rules);
  } catch (e) {
    _sync = { ..._sync, lastError: e.message || 'Sync failed' };
    console.warn('[rules] fetch failed:', e.message);
  }
  return _rules;
}

/**
 * Start keeping this machine's rules current.
 *
 * The cached rules are applied *before* the first fetch, and that ordering is
 * the whole point. Held only in memory, a laptop that starts with no network
 * comes up holding the empty default — and the lock tick, which runs whether a
 * sync succeeded or not, reads an empty set as "nothing is blocked". Airplane
 * mode and a restart would lift every app block and every bedtime until the
 * network came back, which is the one failure mode a parental control must not
 * have.
 */
export async function startRulesSync(onUpdate) {
  _onUpdate = onUpdate;

  const cached = await readJson(CACHE_KEY);
  if (cached && (cached.appRules || cached.websiteRules || cached.screenTimeRule || cached.blocked)) {
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

  /**
   * The parent granting extra minutes for today.
   *
   * Appended from the event rather than by re-syncing, and that speed is the
   * whole feature: a child asks from the lock screen, the parent taps "+15
   * minutes", and the lock has to lift now — not at the end of a five-minute poll
   * while the two of them stand there looking at it.
   *
   * A malformed payload is dropped rather than appended. `bonusMinutesFrom`
   * already ignores a grant it cannot read, but a bad row would still be written
   * to the cache and re-read on every start for as long as the cache lived.
   */
  _unsubscribers.push(onSocket('screen_time_granted', async (grant) => {
    const minutes = Number(grant?.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const grantedAt = grant?.grantedAt || new Date().toISOString();
    _rules = { ..._rules, screenTimeGrants: [...(_rules.screenTimeGrants || []), { minutes, grantedAt }] };
    await writeJson(CACHE_KEY, _rules).catch(() => {});
    if (_onUpdate) await _onUpdate(_rules);
  }));

  /**
   * The parent pausing or resuming this one device.
   *
   * Applied from the event rather than by re-syncing, so the lock appears in
   * about a second instead of at the next five-minute poll — a parent who taps
   * Block is usually standing next to the child. The same value arrives on every
   * sync as well, which is what covers a device that was switched off or offline
   * when the event went out.
   *
   * Written to the cache before it is applied, for the same reason the rules
   * are: an agent killed between the two comes back holding the newer state.
   */
  const applyBlock = (blocked) => async (payload) => {
    _rules = { ..._rules, blocked: blocked ? { since: payload?.since || null, reason: payload?.reason || 'blocked_by_parent' } : null };
    await writeJson(CACHE_KEY, _rules).catch(() => {});
    if (_onUpdate) await _onUpdate(_rules);
  };
  _unsubscribers.push(onSocket('device_blocked', applyBlock(true)));
  _unsubscribers.push(onSocket('device_unblocked', applyBlock(false)));
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
