import { device as deviceApi } from './api.js';
import { onUnlinked } from './link.js';
import { onSocket } from './socket.js';
import { readJson, writeJson } from './store.js';

/**
 * The people the parent has approved.
 *
 * The desktop agent syncs this list for the same reason the phone does and uses
 * it for the same one thing: showing the child who their parent has added. It is
 * not matched against anything — a laptop has no call log and no messages app
 * this agent can read, and Parentix is not going to start reading one.
 *
 * It is here rather than left out because a child is entitled to see what is
 * being kept about them, and because a family that adds a contact on the phone
 * expects to see it on the laptop too.
 */

const CACHE_KEY = 'fg_approved_contacts';
const POLL_INTERVAL = 5 * 60 * 1000; // safety net for a missed socket event
const RETRY_BASE_MS = 5 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const _state = {
  contacts: [],
  syncedAt: null,
  /** True once a list from the server — not the cache — has been applied. */
  fresh: false,
  lastError: null,
};

let _pollTimer = null;
let _retryTimer = null;
let _retryDelay = RETRY_BASE_MS;
let _onUpdate = null;
let _unsubscribers = [];

/**
 * Guards against an out-of-order apply: a parent making several quick edits
 * produces several signals, so several fetches can be in flight and the network
 * is free to settle them in any order.
 */
let _ticket = 0;
let _applied = 0;

export function getContacts() {
  return { ..._state, contacts: [..._state.contacts] };
}

onUnlinked(() => {
  _state.contacts = [];
  _state.syncedAt = null;
  _state.fresh = false;
  _state.lastError = null;
});

const scheduleRetry = () => {
  clearTimeout(_retryTimer);
  _retryTimer = setTimeout(() => { syncContacts(); }, _retryDelay);
  _retryTimer.unref?.();
  _retryDelay = Math.min(_retryDelay * 2, RETRY_MAX_MS);
};

/** Fetch the approved list and replace the local one, so removals take effect. */
export async function syncContacts() {
  const mine = (_ticket += 1);
  try {
    const res = await deviceApi.getContacts();
    const contacts = Array.isArray(res.data?.contacts) ? res.data.contacts : [];

    if (mine <= _applied) return _state.contacts;
    _applied = mine;

    _state.contacts = contacts;
    _state.syncedAt = res.data?.syncedAt || new Date().toISOString();
    _state.fresh = true;
    _state.lastError = null;

    clearTimeout(_retryTimer);
    _retryTimer = null;
    _retryDelay = RETRY_BASE_MS;

    await writeJson(CACHE_KEY, { contacts, syncedAt: _state.syncedAt });
    if (_onUpdate) await _onUpdate(getContacts());
    return _state.contacts;
  } catch (err) {
    _state.lastError = err.message;
    console.warn('[contacts] sync failed:', err.message);
    scheduleRetry();
    return _state.contacts;
  }
}

export async function startContactsSync(onUpdate) {
  _onUpdate = onUpdate;

  const cached = await readJson(CACHE_KEY);
  if (cached?.contacts) {
    _state.contacts = cached.contacts;
    _state.syncedAt = cached.syncedAt || null;
    // Deliberately not `fresh`: this is the last list seen, which is enough to
    // show but not enough to describe as current.
    if (_onUpdate) await _onUpdate(getContacts());
  }

  await syncContacts();

  clearInterval(_pollTimer);
  _pollTimer = setInterval(syncContacts, POLL_INTERVAL);
  _pollTimer.unref?.();

  _unsubscribers.push(onSocket('contacts_updated', syncContacts));
  _unsubscribers.push(onSocket('connect', syncContacts));
}

export function stopContactsSync() {
  clearInterval(_pollTimer);
  _pollTimer = null;
  clearTimeout(_retryTimer);
  _retryTimer = null;
  _retryDelay = RETRY_BASE_MS;
  _unsubscribers.forEach((off) => off());
  _unsubscribers = [];
  _onUpdate = null;
}
