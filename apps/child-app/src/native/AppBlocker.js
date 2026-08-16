import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { AppBlocker: Native } = NativeModules;

const noopSub = { remove: () => {} };

/**
 * Pausing apps the parent has blocked.
 *
 * Android does this by package name: the parent picks "Instagram" in the Family
 * App, the rule travels as `com.instagram.android`, and `AppMonitorService`
 * draws over it when it comes to the foreground.
 *
 * iOS can shield apps, but not on those terms, which is why this is a stub here
 * rather than a second implementation. Apple's `ManagedSettings` blocks apps
 * identified by `ApplicationToken` — an opaque value that can only be produced
 * by the user themselves tapping the app in a system `FamilyActivityPicker` on
 * that device. A token cannot be constructed from a bundle identifier, cannot be
 * read back into one, and is meaningless outside the device that minted it. So
 * the server cannot express "block Instagram" in a form an iPhone can act on,
 * and the parent cannot choose the app remotely at all.
 *
 * Supporting it therefore needs two things this app does not have: Apple's
 * `com.apple.developer.family-controls` entitlement, which is granted by
 * application rather than by enabling a checkbox, and a different rule model in
 * which the managed set is chosen once on the child's phone and the parent's
 * rules act on that set. See docs/IOS.md.
 */
const stub = {
  supported: false,
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
  Platform.OS === 'android' && Native
    ? { ...Native, supported: true, onAppBlocked }
    : stub;

export default AppBlocker;
