import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { VpnControl: Native } = NativeModules;

const noopSub = { remove: () => {} };

const stub = {
  startVpn: async (_domains) => false,
  stopVpn: async () => false,
  hasPermission: async () => false,
  requestPermission: async () => false,
  flushWebHistory: async () => false,
  onWebVisits: (_cb) => noopSub,
};

let emitter = null;

/**
 * Subscribe to batches of resolved domains from the DNS proxy.
 *
 * The callback receives an array of `{ domain, firstSeen, lastSeen, count,
 * blocked }` — one entry per domain per flush window, not one per lookup.
 */
function onWebVisits(callback) {
  if (Platform.OS !== 'android' || !Native) return noopSub;
  if (!emitter) emitter = new NativeEventEmitter(Native);
  return emitter.addListener('onWebVisits', callback);
}

const VpnControl =
  Platform.OS === 'android' && Native ? { ...Native, onWebVisits } : stub;

export default VpnControl;
