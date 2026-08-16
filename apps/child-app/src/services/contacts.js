import { device as deviceApi } from './api';
import { onUnlinked } from './link';
import { onSocket } from './socket';
import { readJson, writeJson } from './secureCache';

const CACHE_KEY = 'fg_approved_contacts';
const POLL_INTERVAL = 5 * 60 * 1000; // safety net for a missed socket event
const RETRY_BASE_MS = 5 * 1000;      // first retry after a failed sync
const RETRY_MAX_MS = 5 * 60 * 1000;  // and never further apart than this

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
 * Guards against an out-of-order apply.
 *
 * A parent making several quick edits produces several `contacts_updated`
 * signals, so several fetches can be in flight at once and the network is free
 * to settle them in any order. Each fetch takes a ticket, and a response only
 * applies if no later ticket has already been applied — which is what makes the
 * last valid state win rather than whichever response happened to land last.
 */
let _ticket = 0;
let _applied = 0;

export function getContacts() {
  return { ..._state, contacts: [..._state.contacts] };
}

/**
 * An unlinked device holds nobody's approved list.
 *
 * `link.js` clears the cache on disk; this is the copy the policy is actually
 * enforced from. A handset moved from one sibling to the next would otherwise
 * spend the first moments of its new link treating the previous child's contacts
 * as approved — and, worse, the new child's real contacts as unknown, alerting
 * their parent about them.
 */
onUnlinked(() => {
  _state.contacts = [];
  _state.syncedAt = null;
  _state.fresh = false;
  _state.lastError = null;
});

// ── Phone matching ───────────────────────────────────────────────────────────

/** Digits only, so "+1 (555) 010-0199" and "555-0100199" compare equal. */
const normalizeNumber = (value) => String(value || '').replace(/\D/g, '');

/**
 * Whether two numbers identify the same line.
 *
 * The parent types a number in whatever form they know it, and the phone reports
 * it in whatever form the network delivers — one may carry a country or trunk
 * code the other omits. Comparing the shorter against the tail of the longer
 * absorbs that, with a seven-digit floor so that a short code or an extension
 * can never match a full number by coincidence.
 */
const sameNumber = (a, b) => {
  const x = normalizeNumber(a);
  const y = normalizeNumber(b);
  if (!x || !y) return false;
  if (x === y) return true;

  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (shorter.length < 7) return false;
  return longer.endsWith(shorter);
};

/** Whether a number belongs to a contact the parent has approved. */
export function isApprovedNumber(phoneNumber) {
  if (!normalizeNumber(phoneNumber)) return false;
  return _state.contacts.some((c) => sameNumber(c.phoneNumber, phoneNumber));
}

export function findContact(phoneNumber) {
  return _state.contacts.find((c) => sameNumber(c.phoneNumber, phoneNumber)) || null;
}

/*
 * `checkIncomingContact` used to live here: it matched a caller against the
 * approved list and emitted `alert:unknown_contact` when the match failed.
 *
 * Nothing ever called it, and nothing could. Seeing who is calling needs
 * READ_CALL_LOG on Android 9+, and seeing a text needs RECEIVE_SMS — both on
 * Google Play's restricted list, both requiring a reviewed use case, on an app
 * that has deliberately kept its permissions narrow enough to explain to a
 * family. That is a product decision and the answer is no, so the check has been
 * removed rather than left as an entry point waiting for a caller that is not
 * coming. The server-side handler and the alert type went with it.
 *
 * What stays is the list itself, and it is not idle: `isApprovedNumber` and
 * `findContact` are exported for anything that legitimately knows a number, and
 * the Settings screen shows the child who their parent has approved — which is
 * the honest use of a list synced to their phone, and the one thing here a child
 * is entitled to see.
 */

// ── Sync ─────────────────────────────────────────────────────────────────────

const scheduleRetry = () => {
  clearTimeout(_retryTimer);
  _retryTimer = setTimeout(() => { syncContacts(); }, _retryDelay);
  // Back off so a device that is offline for hours is not retrying every five
  // seconds for all of them, then cap it so recovery stays prompt.
  _retryDelay = Math.min(_retryDelay * 2, RETRY_MAX_MS);
};

/**
 * Fetch the approved list and replace the local one.
 *
 * The whole list is replaced rather than merged. That is what makes removals and
 * un-approvals take effect — a merge would leave a revoked contact behind — and
 * it is also why repeated syncs cannot accumulate duplicates.
 */
export async function syncContacts() {
  const mine = (_ticket += 1);
  try {
    const res = await deviceApi.getContacts();
    const contacts = Array.isArray(res.data?.contacts) ? res.data.contacts : [];

    // A response overtaken by a later one is dropped, not applied.
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
    // Keep serving the last known list: a failed sync must not leave the device
    // treating every approved contact as unknown.
    _state.lastError = err.message;
    console.warn('[contacts] sync failed:', err.message);
    scheduleRetry();
    return _state.contacts;
  }
}

/**
 * Start keeping the approved list current.
 *
 * The cached list is applied first so a device that restarts with no network
 * still enforces the last list the parent approved, then a fetch brings it up to
 * date. Both a socket signal and a poll drive later syncs — the signal for
 * promptness, the poll to close the gap when one is missed.
 */
export async function startContactsSync(onUpdate) {
  _onUpdate = onUpdate;

  const cached = await readJson(CACHE_KEY);
  if (cached?.contacts) {
    _state.contacts = cached.contacts;
    _state.syncedAt = cached.syncedAt || null;
    // Deliberately not `fresh`: this list is the last one seen, which is enough
    // to enforce with but not enough to start calling people unknown over.
    if (_onUpdate) await _onUpdate(getContacts());
  }

  await syncContacts();

  clearInterval(_pollTimer);
  _pollTimer = setInterval(syncContacts, POLL_INTERVAL);

  _unsubscribers.push(onSocket('contacts_updated', syncContacts));
  // A reconnect means the device may have missed signals while it was away.
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

export const __testing = { sameNumber, normalizeNumber };
