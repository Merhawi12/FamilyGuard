import { notifications as notificationsApi } from '@parentix/shared';

/**
 * Notifications for the parent, on whichever thing they are holding.
 *
 * Two transports behind one interface, because the same app ships two ways:
 *
 *   browser  Web Push against a service worker, keyed by VAPID.
 *   android  FCM through Capacitor. The wrapper is a WebView, and WebView does
 *            not implement the Push API — `PushManager` is simply absent — so
 *            the browser path is not merely unsuitable there, it is impossible.
 *            Without this the Android app reported "this browser does not
 *            support notifications" and no parent using it was ever notified.
 *
 * Every call reports a reason when it cannot proceed rather than throwing, so
 * the settings screen can explain what happened — "you blocked notifications",
 * "this browser does not support them", "the server has no keys" are three very
 * different things to a parent trying to work out why nothing arrives.
 */

const SW_PATH = '/sw.js';

// ── Which transport ───────────────────────────────────────────────────────────

/**
 * Capacitor injects this global into the WebView; a plain browser never has it.
 * Read through optional chaining rather than imported, so the web build does not
 * pull the native plugin into its bundle.
 */
const nativePlatform = () =>
  (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) || false;

/**
 * Whether this is the Android app rather than a browser. Exported because the
 * settings screen has to word itself differently: the remedy for a blocked
 * permission is in Android's app settings, not the browser's site settings.
 */
export const isNativeApp = nativePlatform;

/**
 * The plugin is loaded on demand and only on a device.
 *
 * A static import would put it in the browser bundle too, where it is dead
 * weight that also throws on registration. The dynamic import is resolved once
 * and cached.
 */
let pushPlugin = null;
const nativePush = async () => {
  if (!pushPlugin) ({ PushNotifications: pushPlugin } = await import('@capacitor/push-notifications'));
  return pushPlugin;
};

// ── Browser: Web Push ─────────────────────────────────────────────────────────

const browserPushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

export const pushSupported = () => nativePlatform() || browserPushSupported();

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export const permissionState = () => {
  // On Android the answer lives behind an async plugin call, and this is used
  // synchronously for first paint. 'default' is the honest placeholder — it says
  // "not decided yet" and leaves the toggle usable; refreshNativePermission()
  // replaces it as soon as the plugin answers.
  if (nativePlatform()) return nativeState.permission;
  return browserPushSupported() ? Notification.permission : 'unsupported';
};

/** The VAPID public key arrives base64url-encoded; the browser wants bytes. */
const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

const registerWorker = async () => {
  const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
  const registration = existing || (await navigator.serviceWorker.register(SW_PATH));
  // A freshly registered worker is not usable until it is active.
  await navigator.serviceWorker.ready;
  return registration;
};

const enableWebPush = async (config) => {
  if (!config?.available || !config.publicKey) return { ok: false, reason: 'not-configured' };

  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return { ok: false, reason: result === 'denied' ? 'denied' : 'dismissed' };
  }

  try {
    const registration = await registerWorker();

    // Reuse the browser's existing subscription when there is one. Unsubscribing
    // and resubscribing would hand the server a new endpoint for the same
    // browser and leave the old row behind.
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      }));

    await notificationsApi.pushSubscribe(subscription.toJSON());
    return { ok: true, reason: 'subscribed' };
  } catch (err) {
    return { ok: false, reason: 'failed', error: err.message };
  }
};

// ── Android: FCM through Capacitor ────────────────────────────────────────────

const nativeState = {
  permission: 'default',
  token: null,
  registered: false,
  listening: false,
  /** Capacitor listener handles, so they can be released rather than leaked. */
  handles: [],
};

/**
 * The plugin hands the token to a listener rather than returning it, so the
 * registration has to be turned back into something awaitable.
 *
 * Both outcomes are terminal and exactly one fires: `registration` with a token,
 * or `registrationError` with a reason. The most common reason by far is a build
 * with no google-services.json, where FCM has nothing to register against — so
 * the error is surfaced rather than swallowed into a generic failure.
 */
const awaitNativeToken = async (plugin) => {
  /**
   * Both handles are removed once the promise settles, and that is not tidiness.
   *
   * These were added and never removed, and `awaitNativeToken` runs on every
   * `resyncPush()` — which the app shell calls on every mount. So each sign-in
   * left two more permanent listeners behind, and every one of them fired on
   * every later `registration` event only to find its own promise already
   * settled and do nothing. Growing set of handles, none of them able to act.
   *
   * The rotation case is handled by the standing listener in
   * `startNativeHandling` instead, which is where it belongs: FCM announces a
   * new token by firing `registration`, and a one-shot promise is the wrong
   * shape for news that can arrive at any time.
   */
  const handles = [];
  const track = (promise) => { promise.then((h) => handles.push(h)).catch(() => {}); };
  const cleanup = () => { for (const h of handles) h?.remove?.(); handles.length = 0; };

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };

      track(plugin.addListener('registration', (token) => finish(resolve, token.value)));
      track(plugin.addListener('registrationError', (err) =>
        finish(reject, new Error(err?.error || 'FCM registration failed'))));

      plugin.register().catch((err) => finish(reject, err));

      // Registration is a round trip to Google's servers; on a device with no
      // connectivity neither listener ever fires and the settings screen would
      // spin forever.
      setTimeout(() => finish(reject, new Error('Timed out registering for notifications')), 20000);
    });
  } finally {
    cleanup();
  }
};

const enableNativePush = async (config) => {
  if (!config?.fcmAvailable) return { ok: false, reason: 'not-configured' };

  const plugin = await nativePush();

  let status = await plugin.checkPermissions();
  if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
    status = await plugin.requestPermissions();
  }
  nativeState.permission = status.receive === 'granted' ? 'granted' : 'denied';
  if (status.receive !== 'granted') return { ok: false, reason: 'denied' };

  try {
    const token = await awaitNativeToken(plugin);
    nativeState.token = token;

    await notificationsApi.pushSubscribe(token, deviceLabel(), 'fcm');
    nativeState.registered = true;
    return { ok: true, reason: 'subscribed' };
  } catch (err) {
    nativeState.registered = false;
    return { ok: false, reason: 'failed', error: err.message };
  }
};

/** Names the row on the settings screen. The UA string is all the WebView offers. */
const deviceLabel = () => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const model = ua.match(/Android[^;]*;\s*([^)]+?)\s*(?:Build|\))/i)?.[1];
  return `Parentix app${model ? ` on ${model}` : ' on Android'}`.slice(0, 120);
};

/**
 * The permission state the synchronous `permissionState()` cannot fetch itself.
 * Call once on mount; it resolves the 'default' placeholder to the real answer.
 */
export async function refreshNativePermission() {
  if (!nativePlatform()) return permissionState();
  try {
    const { receive } = await (await nativePush()).checkPermissions();
    nativeState.permission = receive === 'granted' ? 'granted'
      : receive === 'denied' ? 'denied'
      : 'default';
  } catch {
    nativeState.permission = 'default';
  }
  return nativeState.permission;
}

/**
 * Everything the Android app has to keep listening for, for as long as it runs.
 *
 * Three separate things, and only one of them used to be here.
 *
 * **A tap.** `pushNotificationActionPerformed` fires when the parent opens a
 * notification, and the destination the server named is followed.
 *
 * **A push that arrives while the app is open.** Android's FCM SDK posts a
 * notification to the tray only when the app is *backgrounded*; in the
 * foreground the plugin hands it to `pushNotificationReceived` and nothing is
 * shown. This docblock has always claimed the opposite — "Android suppresses a
 * foreground notification by default, which is wrong here" — and then registered
 * no listener for it, so a parent holding the app open was the one parent who
 * saw nothing when their child pressed the emergency button. It is surfaced
 * in-app instead of re-posting it to the tray: an in-app banner needs no further
 * permission, no second notification channel and no extra dependency, and it can
 * say more than a notification can because the app is right there.
 *
 * **A token this device did not ask for.** FCM reissues a registration token on
 * its own schedule and announces it by firing `registration`. The only listener
 * for that used to be the one-shot inside `awaitNativeToken`, already settled and
 * therefore inert — so a rotation while the app was running was simply dropped,
 * and the server went on pushing to a token Google had retired until the parent
 * happened to reload the app. A standing listener is the shape that news actually
 * has.
 *
 * Idempotent — the settings screen and the app shell may both call it.
 */
export async function startNativeHandling({ onOpen, onForeground } = {}) {
  if (!nativePlatform() || nativeState.listening) return;
  const plugin = await nativePush();
  // Marked before the awaits below, so two callers racing on first paint cannot
  // both get past the guard and register a second set of listeners.
  nativeState.listening = true;

  const handles = await Promise.all([
    plugin.addListener('pushNotificationActionPerformed', (action) => {
      const data = action?.notification?.data || {};
      if (onOpen) onOpen(data);
      else if (data.url) window.location.hash = data.url;
    }),

    plugin.addListener('pushNotificationReceived', (notification) => {
      onForeground?.({
        title: notification?.title || 'Parentix',
        body: notification?.body || '',
        data: notification?.data || {},
      });
    }),

    plugin.addListener('registration', (token) => {
      // Only when it is genuinely new: `awaitNativeToken` also triggers this
      // event, and it has already registered the value it received.
      if (!token?.value || token.value === nativeState.token) return;
      nativeState.token = token.value;
      notificationsApi
        .pushSubscribe(token.value, deviceLabel(), 'fcm')
        .then(() => { nativeState.registered = true; })
        .catch(() => { /* the next resync or an explicit re-enable will retry */ });
    }),
  ]);

  nativeState.handles = handles;
}

/** Release the listeners above. Exported for symmetry and for tests. */
export async function stopNativeHandling() {
  for (const handle of nativeState.handles || []) handle?.remove?.();
  nativeState.handles = [];
  nativeState.listening = false;
}

// ── One interface ─────────────────────────────────────────────────────────────

/**
 * Turn on notifications for this device.
 *
 * Asks for permission only when it has not already been decided: re-prompting
 * someone who said no does nothing in every modern browser except annoy them,
 * and the state is reported back so the UI can explain rather than retry.
 */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };

  const config = await notificationsApi.pushConfig().then((r) => r.data).catch(() => null);
  return nativePlatform() ? enableNativePush(config) : enableWebPush(config);
}

export async function disablePush() {
  if (nativePlatform()) {
    const token = nativeState.token;
    if (!token) return { ok: true, reason: 'not-subscribed' };
    try {
      await notificationsApi.pushUnsubscribe(token);
      // The OS keeps the FCM token — there is nothing to unsubscribe on the
      // device, and revoking it would only make re-enabling slower. Dropping the
      // server's copy is what stops the notifications.
      nativeState.registered = false;
      return { ok: true, reason: 'unsubscribed' };
    } catch (err) {
      return { ok: false, reason: 'failed', error: err.message };
    }
  }

  if (!browserPushSupported()) return { ok: false, reason: 'unsupported' };

  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return { ok: true, reason: 'not-subscribed' };

    // Told to the server first: if the browser drops it first and the request
    // then fails, the server keeps pushing to an endpoint nothing will receive.
    await notificationsApi.pushUnsubscribe(subscription.toJSON()).catch(() => {});
    await subscription.unsubscribe();
    return { ok: true, reason: 'unsubscribed' };
  } catch (err) {
    return { ok: false, reason: 'failed', error: err.message };
  }
}

/** Whether this device currently holds a push subscription. */
export async function isSubscribed() {
  if (nativePlatform()) return nativeState.registered;
  if (!browserPushSupported() || Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    return !!(await registration?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Re-register this device's subscription with the server after sign-in.
 *
 * A push subscription belongs to the device, but the server row belongs to an
 * account. Without this, a parent who subscribed, signed out, and signed back in
 * — or who signs in on a device a different family member used — would have a
 * live subscription that the server no longer associates with them.
 */
export async function resyncPush() {
  if (nativePlatform()) {
    // The OS reissues the FCM token on reinstall and occasionally on its own, so
    // this asks for the current one rather than replaying what was cached. The
    // permission prompt is never raised: a parent who has not opted in is not
    // opted in by signing in.
    if ((await refreshNativePermission()) !== 'granted') return;
    try {
      const token = await awaitNativeToken(await nativePush());
      nativeState.token = token;
      await notificationsApi.pushSubscribe(token, deviceLabel(), 'fcm');
      nativeState.registered = true;
    } catch {
      /* best effort — the settings screen can always re-enable explicitly */
    }
    return;
  }

  if (!browserPushSupported() || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await notificationsApi.pushSubscribe(subscription.toJSON());
  } catch {
    /* best effort — the settings screen can always re-enable explicitly */
  }
}
