import { getItem, setItem, removeItem, removeJson } from './store.js';

/**
 * This computer's link to a parent account: storing it, forgetting it, and
 * telling the agent when the server says it is over.
 *
 * A direct port of the mobile app's `services/link.js`, and deliberately so —
 * the two revocation codes below are a contract with the API
 * (`utils/deviceAccess.js`) that is matched literally, and a desktop client that
 * spelled them differently would fail in the one way that is invisible: it would
 * go on presenting a dead token, keep showing itself linked, and keep enforcing
 * the last rules it downloaded, for as long as the child left it installed.
 */

const TOKEN_KEY = 'fg_device_token';
const DEVICE_KEY = 'fg_device_id';
const CHILD_KEY = 'fg_child_id';

/**
 * Everything this machine cached about the child it was linked to.
 *
 * Cleared alongside the credential, because the next link may be to a different
 * child — a parent moving a laptop from one sibling to the next — and an agent
 * that came up holding the previous child's rules would enforce them until the
 * first sync answered.
 */
const CHILD_DATA_KEYS = ['fg_child_name'];
const CHILD_CACHE_KEYS = [
  'fg_device_rules',
  'fg_approved_contacts',
  'fg_web_history_queue',
  'fg_known_apps',
];

/**
 * Why the server refused, as sent by the API.
 *
 * `device_unlinked` is permanent: the device row is gone and no code can bring
 * it back. `account_suspended` is not — a blocked parent, a deactivated child —
 * and the agent must sit on its token and keep retrying, because re-linking
 * would need a fresh code from an account that currently cannot sign in to issue
 * one.
 */
export const DEVICE_UNLINKED = 'device_unlinked';
export const ACCOUNT_SUSPENDED = 'account_suspended';

const _listeners = new Set();
/**
 * Guards against a storm: the rules poll, the web-history upload and the socket
 * can all discover a revocation within the same second, and the child should be
 * sent back to the link screen once rather than three times.
 */
let _unlinking = null;

export async function saveLink({ deviceToken, deviceId, childId }) {
  await setItem(TOKEN_KEY, deviceToken);
  await setItem(DEVICE_KEY, String(deviceId));
  await setItem(CHILD_KEY, String(childId));
  _unlinking = null;
}

export function getDeviceToken() {
  return getItem(TOKEN_KEY);
}

export function getDeviceId() {
  return getItem(DEVICE_KEY);
}

/** Only the REST chat fallback needs this — the socket derives it from the token. */
export function getChildId() {
  return getItem(CHILD_KEY);
}

/** True when this machine holds credentials — what decides the first window. */
export async function hasLink() {
  return !!(await getItem(TOKEN_KEY).catch(() => null));
}

/**
 * Forget the link.
 *
 * Every delete is individually tolerant of failure: a disk that cannot be
 * written is exactly the situation in which the agent must still end up on the
 * link screen, and a throw here would leave it running with a dead token.
 */
export async function clearLink() {
  for (const key of [TOKEN_KEY, DEVICE_KEY, CHILD_KEY, ...CHILD_DATA_KEYS, ...CHILD_CACHE_KEYS]) {
    try { await removeItem(key); } catch { /* nothing to do about it */ }
  }
  try { await removeJson('fg_dns_backup'); } catch { /* same */ }
}

/**
 * Register interest in this device being unlinked. Returns the unsubscribe.
 *
 * A plain listener rather than anything that reaches for a window, because this
 * module is imported by the API client and a service that needs a renderer is a
 * service that cannot be tested without one.
 */
export function onUnlinked(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * The server has told us this device is no longer linked. Clear up and say so.
 *
 * Idempotent: repeated calls while the first is in flight return the same
 * promise.
 */
export function handleUnlinked() {
  if (_unlinking) return _unlinking;
  _unlinking = clearLink().then(() => {
    for (const listener of [..._listeners]) {
      try { listener(); } catch { /* one bad subscriber must not stop the rest */ }
    }
  });
  return _unlinking;
}

/** Called from the API client and the socket with whatever reason the server gave. */
export function handleAuthFailure(code) {
  if (code !== DEVICE_UNLINKED) return false;
  handleUnlinked();
  return true;
}

/** Test seam: forget listeners and any in-flight unlink between runs. */
export function resetLinkState() {
  _listeners.clear();
  _unlinking = null;
}
