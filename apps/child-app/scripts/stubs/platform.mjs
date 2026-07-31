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
  backgroundTasks: [],
  locationTaskOptions: null,
  reset() {
    this.blockedApps = null;
    this.setBlockedAppsCalls = [];
    this.vpnDomains = null;
    this.vpnStarted = false;
    this.backgroundTasks = [];
    this.locationTaskOptions = null;
  },
};

// ── Test-controlled platform state ───────────────────────────────────────────
export const platformState = {
  usageStats: {},
  permissions: {
    usage: true,
    accessibility: true,
    vpn: true,
    locationForeground: true,
    locationBackground: true,
  },
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

// ── expo-location ────────────────────────────────────────────────────────────
export const locationStub = {
  Accuracy: { Balanced: 3 },
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
