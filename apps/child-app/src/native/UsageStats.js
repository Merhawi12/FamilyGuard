import { NativeModules, Platform } from 'react-native';

const { UsageStats: Native } = NativeModules;

/**
 * Screen-time measurement, which exists on Android and cannot exist on iOS.
 *
 * Android answers this with `UsageStatsManager`: a permissioned read of how long
 * every package spent in the foreground, which `monitoring.js` totals and uploads
 * so the parent's Reports screen can show it.
 *
 * iOS has no equivalent and the omission is deliberate on Apple's part. The
 * nearest thing is the `DeviceActivity` framework, and it is not a read API — it
 * hands your numbers to a system-rendered `DeviceActivityReport` view that draws
 * them inside an extension your process cannot read back. You can show a child
 * their own usage; you cannot obtain the figure, so you cannot send it anywhere.
 * There is no entitlement that changes this: it is the privacy guarantee, not a
 * gate in front of one.
 *
 * `supported` is what the UI reads to avoid offering a permission that can never
 * be granted. Returning zeros while claiming success is the failure mode this
 * flag exists to prevent — the parent would see a flat, honest-looking 0m of
 * screen time rather than "this phone cannot report it".
 */
const stub = {
  supported: false,
  getUsageStats: async () => ({}),
  hasPermission: async () => false,
  openSettings: () => {},
};

const UsageStats =
  Platform.OS === 'android' && Native ? { ...Native, supported: true } : stub;

export default UsageStats;
