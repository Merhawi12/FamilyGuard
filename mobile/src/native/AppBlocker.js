import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { AppBlocker: Native } = NativeModules;

const noopSub = { remove: () => {} };

const stub = {
  setBlockedApps: (_packages) => {},
  isAccessibilityEnabled: async () => false,
  openSettings: () => {},
  onAppBlocked: (_cb) => noopSub,
};

let emitter = null;

// Subscribe to native "a blocked app was brought to the foreground" events.
// Returns a subscription with .remove(). Callback receives the package name.
function onAppBlocked(callback) {
  if (Platform.OS !== 'android' || !Native) return noopSub;
  if (!emitter) emitter = new NativeEventEmitter(Native);
  return emitter.addListener('onAppBlocked', callback);
}

const AppBlocker =
  Platform.OS === 'android' && Native ? { ...Native, onAppBlocked } : stub;

export default AppBlocker;
