import { NativeModules, Platform } from 'react-native';

const { AppBlocker: Native } = NativeModules;

const stub = {
  setBlockedApps: (_packages) => {},
  isAccessibilityEnabled: async () => false,
  openSettings: () => {},
};

const AppBlocker = Platform.OS === 'android' && Native ? Native : stub;

export default AppBlocker;
