import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { VpnControl: Native } = NativeModules;

const noopSub = { remove: () => {} };

/**
 * Website filtering, and the web-history feed that falls out of it.
 *
 * Android runs a local `VpnService` that answers DNS itself: it refuses lookups
 * for blocked domains and reports the ones it resolved, which is where both
 * website blocking and the parent's Web History screen come from. Nothing leaves
 * the phone to a third party — the "VPN" is a loopback.
 *
 * iOS has the building blocks and puts them behind supervision. `NEDNSProxy
 * Provider` and `NEFilterDataProvider` — the two Network Extension providers
 * that could do this — are refused at install time unless the device is
 * *supervised*, which means enrolled through Apple Configurator or Apple
 * Business/School Manager and managed by an MDM server. A consumer iPhone set up
 * at home is not supervised and cannot be made so without erasing it.
 *
 * `ManagedSettings` offers a much coarser alternative for the blocking half —
 * `webContent.blockedByFilter`, which restricts Safari and needs the same
 * Family Controls entitlement as app shielding. It cannot see other browsers and
 * it reports nothing, so it would give a weak version of website blocking and no
 * web history at all.
 *
 * Neither route is a port of what Android does, so this stays a stub on iOS and
 * `monitoring.js` simply never turns the feature on. See docs/IOS.md.
 */
const stub = {
  supported: false,
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
  Platform.OS === 'android' && Native
    ? { ...Native, supported: true, onWebVisits }
    : stub;

export default VpnControl;
