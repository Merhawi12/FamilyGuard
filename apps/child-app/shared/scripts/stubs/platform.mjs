/**
 * Stand-ins for the Expo and React Native modules the child app's service layer
 * imports, so that layer can run under plain Node against a real API.
 *
 * These are deliberately thin: they record what the app asked the platform to
 * do (block these packages, start a VPN with these domains) so a test can
 * assert on it, and they let a test drive the platform back (usage stats for a
 * given day, a native "blocked app" event). Everything above them — api.js,
 * socket.js, rules.js, chat.js, monitoring.js — is the real shipping code.
 */

// ── Recorded calls ───────────────────────────────────────────────────────────
export const spy = {
  blockedApps: null,      // last argument to AppBlocker.setBlockedApps
  setBlockedAppsCalls: [],
  vpnDomains: null,       // last argument to VpnControl.startVpn
  vpnStarted: false,
  webHistoryFlushes: 0,   // times JS asked the DNS proxy for its buffer
  notificationHandler: null,
  notificationChannels: [],
  notificationPrompts: 0,
  pushTokenRequests: [],
  backgroundTasks: [],
  locationTaskOptions: null,
  reset() {
    this.blockedApps = null;
    this.setBlockedAppsCalls = [];
    this.vpnDomains = null;
    this.vpnStarted = false;
    this.webHistoryFlushes = 0;
    this.notificationHandler = null;
    this.notificationChannels = [];
    this.notificationPrompts = 0;
    this.pushTokenRequests = [];
    this.backgroundTasks = [];
    this.locationTaskOptions = null;
  },
};

// ── Test-controlled platform state ───────────────────────────────────────────
export const platformState = {
  usageStats: {},
  /** Domains the DNS proxy has seen but not yet handed to JS. */
  pendingWebVisits: [],
  permissions: {
    usage: true,
    accessibility: true,
    vpn: true,
    locationForeground: true,
    locationBackground: true,
    /** 'granted' | 'denied' | 'undetermined' — the OS's notification answer. */
    notifications: 'undetermined',
  },
  /** False once the OS will no longer show the notification prompt. */
  canAskForNotifications: true,
  /** What the prompt resolves to when it is shown. */
  notificationPromptResult: 'granted',
  expoPushToken: 'ExponentPushToken[e2e-child-device-token]',
  /** A notification response waiting from before the app started, or null. */
  coldStartNotification: null,
};

// ── expo-secure-store ────────────────────────────────────────────────────────
const secureStore = new Map();
export const secureStoreStub = {
  async getItemAsync(key) { return secureStore.has(key) ? secureStore.get(key) : null; },
  async setItemAsync(key, value) { secureStore.set(key, String(value)); },
  async deleteItemAsync(key) { secureStore.delete(key); },
  __clear() { secureStore.clear(); },
};

// ── react-native ─────────────────────────────────────────────────────────────
/** Listeners registered through NativeEventEmitter, keyed by event name. */
const nativeListeners = new Map();

export function emitNativeEvent(event, payload) {
  for (const handler of nativeListeners.get(event) || []) handler(payload);
}

export const NativeModules = {
  AppBlocker: {
    setBlockedApps(packages) {
      spy.blockedApps = packages;
      spy.setBlockedAppsCalls.push(packages);
    },
    async isAccessibilityEnabled() { return platformState.permissions.accessibility; },
    openSettings() {},
    addListener() {},
    removeListeners() {},
  },
  UsageStats: {
    async hasPermission() { return platformState.permissions.usage; },
    async getUsageStats() { return platformState.usageStats; },
    openSettings() {},
  },
  VpnControl: {
    async hasPermission() { return platformState.permissions.vpn; },
    async requestPermission() { return platformState.permissions.vpn; },
    async startVpn(domains) { spy.vpnDomains = domains; spy.vpnStarted = true; return true; },
    async stopVpn() { spy.vpnStarted = false; return true; },
    /**
     * Stands in for the DNS proxy's flush. A test queues domains through
     * `platformState.pendingWebVisits` and this hands them to JS the way the
     * native reporter's batch emit does.
     */
    async flushWebHistory() {
      spy.webHistoryFlushes += 1;
      const pending = platformState.pendingWebVisits;
      if (pending.length === 0) return true;
      platformState.pendingWebVisits = [];
      emitNativeEvent('onWebVisits', pending);
      return true;
    },
    addListener() {},
    removeListeners() {},
  },
};

export const Platform = { OS: 'android', select: (map) => map.android ?? map.default };

export class NativeEventEmitter {
  addListener(event, handler) {
    if (!nativeListeners.has(event)) nativeListeners.set(event, new Set());
    nativeListeners.get(event).add(handler);
    return { remove: () => nativeListeners.get(event)?.delete(handler) };
  }
}

// ── expo-device / expo-constants ─────────────────────────────────────────────
// `isDevice` is fixed true: emulator detection is a property of the hardware,
// not something this harness can meaningfully vary.
export const deviceInfoStub = { isDevice: true, manufacturer: 'Google', modelName: 'Pixel 7' };

export const constantsStub = {
  expoConfig: { extra: { eas: { projectId: 'e2e-project-id' } } },
  easConfig: { projectId: 'e2e-project-id' },
};

// ── expo-notifications ───────────────────────────────────────────────────────
/** Notifications the app asked the OS to display while in the foreground. */
const notificationListeners = { received: new Set(), response: new Set() };

export const notificationsStub = {
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },

  setNotificationHandler(handler) { spy.notificationHandler = handler; },

  async setNotificationChannelAsync(id, options) {
    spy.notificationChannels.push({ id, options });
  },

  async getPermissionsAsync() {
    const state = platformState.permissions.notifications;
    return { status: state, granted: state === 'granted', canAskAgain: platformState.canAskForNotifications };
  },

  async requestPermissionsAsync() {
    // Mirrors the OS: a prompt is only answered when the app is allowed to ask.
    if (platformState.canAskForNotifications) {
      platformState.permissions.notifications = platformState.notificationPromptResult;
    }
    const state = platformState.permissions.notifications;
    spy.notificationPrompts += 1;
    return { status: state, granted: state === 'granted', canAskAgain: platformState.canAskForNotifications };
  },

  async getExpoPushTokenAsync({ projectId } = {}) {
    spy.pushTokenRequests.push(projectId);
    return { data: platformState.expoPushToken };
  },

  addNotificationReceivedListener(handler) {
    notificationListeners.received.add(handler);
    return { remove: () => notificationListeners.received.delete(handler) };
  },

  addNotificationResponseReceivedListener(handler) {
    notificationListeners.response.add(handler);
    return { remove: () => notificationListeners.response.delete(handler) };
  },

  async getLastNotificationResponseAsync() {
    return platformState.coldStartNotification;
  },
};

/** Deliver a notification to the app the way the OS would. */
export function deliverNotification(data, { tapped = false } = {}) {
  const notification = { request: { content: { data } } };
  if (tapped) {
    for (const handler of notificationListeners.response) handler({ notification });
  } else {
    for (const handler of notificationListeners.received) handler(notification);
  }
}

// ── expo-location ────────────────────────────────────────────────────────────
export const locationStub = {
  Accuracy: { Balanced: 3 },
  /**
   * The real enum's values, not invented ones.
   *
   * `monitoring.js` passes `ActivityType.Other` to stop iOS suspending location
   * updates when it decides the phone has been sitting still. A stub missing the
   * enum does not fail politely — reading `.Other` off `undefined` throws inside
   * `startLocationTracking`, which is how this was found: the whole harness went
   * from 173 passing checks to a bare `fetch failed` with nothing naming
   * location.
   *
   * Transcribed from expo-location rather than made up, for the reason
   * [[mfa-otplib-v13]] cost an afternoon: a stub that invents an API agrees with
   * the test and disagrees with production.
   */
  ActivityType: {
    Other: 1,
    AutomotiveNavigation: 2,
    Fitness: 3,
    OtherNavigation: 4,
    Airborne: 5,
  },
  async getForegroundPermissionsAsync() { return { granted: platformState.permissions.locationForeground }; },
  async getBackgroundPermissionsAsync() { return { granted: platformState.permissions.locationBackground }; },
  async requestForegroundPermissionsAsync() { return { granted: true }; },
  async requestBackgroundPermissionsAsync() { return { granted: true }; },
  async startLocationUpdatesAsync(task, options) { spy.locationTaskOptions = options; },
  async stopLocationUpdatesAsync() {},
};

// ── expo-task-manager ────────────────────────────────────────────────────────
const tasks = new Map();
export const taskManagerStub = {
  isTaskDefined: (name) => tasks.has(name),
  defineTask: (name, fn) => tasks.set(name, fn),
  /** Lets a test run a background task body directly. */
  __run: (name, arg) => tasks.get(name)?.(arg),
};

// ── expo-background-fetch ────────────────────────────────────────────────────
export const backgroundFetchStub = {
  BackgroundFetchResult: { NewData: 1, NoData: 2, Failed: 3 },
  async registerTaskAsync(name, options) { spy.backgroundTasks.push({ name, options }); },
  async unregisterTaskAsync() {},
};
