import * as SecureStore from 'expo-secure-store';
import { removeJson } from './secureCache';

/**
 * This phone's link to a parent account: storing it, forgetting it, and telling
 * the app when the server says it is over.
 *
 * The credentials used to be written inline by the link screen and read inline
 * by everything else, and nothing ever removed them. That was fine right up to
 * the moment a parent removed the device: the token stayed in the keystore, the
 * app went on presenting it, the API answered 401 to every call, and the phone
 * carried on showing "Linked to your parent" and enforcing the last rules it had
 * downloaded. The only way out was to clear the app's data from Android
 * Settings, which is not something a child is going to find.
 *
 * So one module owns the credential and one rule governs discarding it.
 */

/** The credential itself, and the ids every screen reads back. */
const TOKEN_KEY = 'fg_device_token';
const DEVICE_KEY = 'fg_device_id';
const CHILD_KEY = 'fg_child_id';

/**
 * Everything this phone cached about the child it was linked to.
 *
 * Cleared alongside the credential, because the next link may be to a different
 * child — a parent moving a handset from one sibling to another — and a device
 * that came up holding the previous child's approved contacts would enforce that
 * list until the first sync answered. The greeting would have used their name,
 * too.
 */
const CHILD_DATA_KEYS = ['fg_child_name'];
const CHILD_CACHE_KEYS = ['fg_approved_contacts', 'fg_web_history_queue', 'fg_push_token'];

/**
 * Why the server refused, as sent by the API.
 *
 * `device_unlinked` is permanent: the device row is gone and no code can bring
 * it back. `account_suspended` is not — a blocked parent, a deactivated child —
 * and the phone must sit on its token and keep retrying, because re-linking
 * would need a fresh code from an account that currently cannot sign in to issue
 * one. Matched literally against the API's `utils/deviceAccess.js`.
 */
export const DEVICE_UNLINKED = 'device_unlinked';
export const ACCOUNT_SUSPENDED = 'account_suspended';

/** Subscribers notified once, when this device stops being linked. */
const _listeners = new Set();
/**
 * Guards against a storm: a background sync, the rules poll and the socket can
 * all discover the revocation within the same second, and the child should be
 * sent back to the link screen once rather than three times.
 */
let _unlinking = null;

export async function saveLink({ deviceToken, deviceId, childId }) {
  await SecureStore.setItemAsync(TOKEN_KEY, deviceToken);
  await SecureStore.setItemAsync(DEVICE_KEY, String(deviceId));
  await SecureStore.setItemAsync(CHILD_KEY, String(childId));
  // A device that was unlinked and is now being linked again starts clean.
  _unlinking = null;
}

export function getDeviceToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export function getDeviceId() {
  return SecureStore.getItemAsync(DEVICE_KEY);
}

/** Only the REST chat fallback needs this — the socket derives it from the token. */
export function getChildId() {
  return SecureStore.getItemAsync(CHILD_KEY);
}

/** True when this phone holds credentials — what decides the app's first screen. */
export async function hasLink() {
  return !!(await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null));
}

/**
 * Forget the link.
 *
 * Every delete is individually tolerant of failure: a keystore that cannot be
 * written is exactly the situation in which the app must still end up on the
 * link screen, and a throw here would leave it on Home holding a dead token.
 */
export async function clearLink() {
  const forget = async (key) => {
    try { await SecureStore.deleteItemAsync(key); } catch { /* nothing to do about it */ }
  };
  for (const key of [TOKEN_KEY, DEVICE_KEY, CHILD_KEY, ...CHILD_DATA_KEYS]) await forget(key);
  for (const key of CHILD_CACHE_KEYS) {
    try { await removeJson(key); } catch { /* same */ }
  }
}

/**
 * Register interest in this device being unlinked. Returns the unsubscribe.
 *
 * The app shell uses it to stop monitoring and send the child back to the link
 * screen. It is a plain listener rather than navigation done from here because
 * this module is imported by the API client, and a service that reaches for the
 * navigator is a service that cannot be tested without one.
 */
export function onUnlinked(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * The server has told us this device is no longer linked. Clear up and say so.
 *
 * Idempotent: repeated calls while the first is in flight return the same
 * promise, and calls after it has settled are cheap no-ops for a device that has
 * already been sent back to the link screen.
 */
export function handleUnlinked() {
  if (_unlinking) return _unlinking;
  _unlinking = clearLink()
    .then(() => {
      for (const listener of [..._listeners]) {
        try { listener(); } catch { /* one bad subscriber must not stop the rest */ }
      }
    });
  return _unlinking;
}

/**
 * Called from the API client and the socket with whatever reason the server
 * gave. Only the permanent one discards anything — see the constants above.
 */
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
