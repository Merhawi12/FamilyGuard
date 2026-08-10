import { device as deviceApi } from './api';
import { connectSocket, onSocket, emitSocket } from './socket';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 min

let _rules = { appRules: [], websiteRules: [], screenTimeRule: null };
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

export async function fetchRules() {
  try {
    const res = await deviceApi.getRules();
    _rules = res.data;
    _sync = { lastSyncAt: new Date().toISOString(), lastError: null };
    if (_onUpdate) await _onUpdate(_rules);
  } catch (e) {
    _sync = { ..._sync, lastError: e.message || 'Sync failed' };
    console.warn('[rules] fetch failed:', e.message);
  }
}

export async function startRulesSync(onUpdate) {
  _onUpdate = onUpdate;

  await fetchRules();

  // Poll as a safety net for a missed socket event or a long offline stretch.
  clearInterval(_pollTimer);
  _pollTimer = setInterval(fetchRules, POLL_INTERVAL);

  await connectSocket();

  _unsubscribers.push(onSocket('rules_updated', fetchRules));
  _unsubscribers.push(onSocket('screen_time_updated', async (rule) => {
    _rules = { ..._rules, screenTimeRule: rule };
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
