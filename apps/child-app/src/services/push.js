import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { device as deviceApi } from './api';
import { onUnlinked } from './link';
import { readJson, writeJson } from './secureCache';
import { colors } from '../theme';

/**
 * Notifications on the child device.
 *
 * Push is what reaches the child when the app is in the background or has been
 * swapped out — the socket is only connected while the app is alive, so anything
 * that has to arrive regardless goes through here.
 *
 * Every entry point reports why it could not proceed instead of failing
 * silently, because "no notifications arrived" has several very different
 * causes and the permissions screen has to be able to tell them apart.
 */

const TOKEN_KEY = 'fg_push_token';
const ANDROID_CHANNEL = 'parentix-alerts';

const _state = {
  permission: 'undetermined', // 'granted' | 'denied' | 'undetermined' | 'unsupported'
  token: null,
  registered: false,
  lastError: null,
};

/**
 * A push token is registered against a device row, so an unlink retires it.
 *
 * `link.js` deletes the stored copy, which is what `registerForPush` consults
 * before deciding an unchanged token needs no re-send — without that, a phone
 * linked to a second device row would report itself registered and never tell
 * the server where to reach it. This clears the matching in-memory flags so the
 * permissions screen does not claim notifications are set up in the meantime.
 */
onUnlinked(() => {
  _state.registered = false;
  _state.lastError = null;
});

let _receivedSub = null;
let _responseSub = null;

export function getPushStatus() {
  return { ..._state };
}

/**
 * Show a notification that arrives while the app is open.
 *
 * Without this the OS suppresses foreground notifications, which is usually
 * right but not here: a message from a parent should be visible whether or not
 * the child happens to have the app in front of them.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Android needs a channel before anything can be delivered to it, and the
 * channel has to exist before the first notification — one created afterwards
 * does not retro-apply to messages already sent.
 */
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
    name: 'Parentix alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    // colors.teal700 — the app's primary, not the pre-rebrand blue.
    lightColor: colors.teal700,
  });
}

/**
 * Current permission state, without prompting.
 *
 * Read rather than requested, so a screen can show where things stand without
 * the side effect of a prompt — asking repeatedly is both useless once the
 * answer is "no" and a good way to get an app dismissed.
 */
export async function checkPermission() {
  if (!Device.isDevice) {
    _state.permission = 'unsupported';
    return _state.permission;
  }
  const { status } = await Notifications.getPermissionsAsync();
  _state.permission = status;
  return status;
}

/**
 * Ask for notification permission, once.
 *
 * A prompt is only raised while the answer is still undetermined. After a denial
 * the OS will not show it again, so this reports the state and leaves it to the
 * caller to point the child at system settings.
 */
export async function requestPermission() {
  if (!Device.isDevice) {
    _state.permission = 'unsupported';
    return { granted: false, status: 'unsupported' };
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted') {
    _state.permission = 'granted';
    return { granted: true, status: 'granted' };
  }
  if (!existing.canAskAgain) {
    _state.permission = existing.status;
    return { granted: false, status: existing.status, mustUseSettings: true };
  }

  const { status } = await Notifications.requestPermissionsAsync();
  _state.permission = status;
  return { granted: status === 'granted', status };
}

const projectId = () =>
  Constants?.expoConfig?.extra?.eas?.projectId || Constants?.easConfig?.projectId || undefined;

/**
 * Obtain this install's push token and hand it to the API.
 *
 * The token is cached and only re-sent when it changes: the OS reissues it on
 * reinstall and occasionally on its own, and re-registering an unchanged token
 * on every launch is a request per start for nothing. A cached token is still
 * re-sent after a failure, so a registration that failed offline is retried.
 */
export async function registerForPush({ force = false } = {}) {
  try {
    if (!Device.isDevice) {
      _state.permission = 'unsupported';
      _state.lastError = 'Push requires a physical device';
      return { ok: false, reason: 'unsupported' };
    }

    const { granted, status } = await requestPermission();
    if (!granted) {
      _state.lastError = null; // a refusal is an answer, not a fault
      return { ok: false, reason: status === 'denied' ? 'denied' : 'not-granted' };
    }

    await ensureAndroidChannel();

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    _state.token = token;

    const cached = await readJson(TOKEN_KEY);
    if (!force && cached?.token === token && cached?.registered) {
      _state.registered = true;
      return { ok: true, reason: 'already-registered', token };
    }

    /**
     * The label the parent sees in their device list, so the fallback must not
     * name a platform this phone might not be. `modelName` is null often enough
     * on Android to need one, and "Android device" on an iPhone is worse than
     * saying nothing specific — the parent uses this string to tell two of their
     * children's phones apart.
     */
    const fallbackModel = Platform.OS === 'ios' ? 'iPhone' : 'Android device';
    await deviceApi.registerPushToken(token, `${Device.manufacturer || ''} ${Device.modelName || fallbackModel}`.trim());
    _state.registered = true;
    _state.lastError = null;
    await writeJson(TOKEN_KEY, { token, registered: true });

    return { ok: true, reason: 'registered', token };
  } catch (err) {
    // Most often simply offline at launch. The token is remembered as
    // unregistered so the next attempt re-sends it.
    _state.registered = false;
    _state.lastError = err.message;
    console.warn('[push] registration failed:', err.message);
    if (_state.token) await writeJson(TOKEN_KEY, { token: _state.token, registered: false });
    return { ok: false, reason: 'failed', error: err.message };
  }
}

/** Stop this device receiving pushes — used when the device is unlinked. */
export async function unregisterPush() {
  try {
    await deviceApi.removePushToken(_state.token || undefined);
  } catch (err) {
    console.warn('[push] unregister failed:', err.message);
  }
  _state.registered = false;
  _state.token = null;
  await writeJson(TOKEN_KEY, { token: null, registered: false });
}

/**
 * Wire up notification handling.
 *
 * `onOpen` is called with the notification's data when the child taps one,
 * whether the app was in the foreground, in the background, or not running at
 * all — the last of which arrives through `getLastNotificationResponseAsync`
 * rather than the listener, since the tap happened before any listener existed.
 */
export async function startPushHandling({ onReceive, onOpen } = {}) {
  _receivedSub?.remove();
  _responseSub?.remove();

  _receivedSub = Notifications.addNotificationReceivedListener((notification) => {
    onReceive?.(notification.request?.content?.data || {}, notification);
  });

  _responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
    onOpen?.(response.notification?.request?.content?.data || {}, response);
  });

  // A notification the child tapped to launch the app from cold.
  const initial = await Notifications.getLastNotificationResponseAsync();
  if (initial) onOpen?.(initial.notification?.request?.content?.data || {}, initial);
}

export function stopPushHandling() {
  _receivedSub?.remove();
  _receivedSub = null;
  _responseSub?.remove();
  _responseSub = null;
}
