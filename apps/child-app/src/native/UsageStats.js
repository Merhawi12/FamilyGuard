import { NativeModules, Platform } from 'react-native';

const { UsageStats: Native } = NativeModules;

const stub = {
  getUsageStats: async () => ({}),
  hasPermission: async () => false,
  openSettings: () => {},
};

// On non-Android or when native module isn't built yet, fall back to stubs
const UsageStats = Platform.OS === 'android' && Native ? Native : stub;

export default UsageStats;
