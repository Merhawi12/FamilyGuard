import { NativeModules, Platform } from 'react-native';

const { VpnControl: Native } = NativeModules;

const stub = {
  startVpn: async (_domains) => false,
  stopVpn: async () => false,
  hasPermission: async () => false,
  requestPermission: async () => false,
};

const VpnControl = Platform.OS === 'android' && Native ? Native : stub;

export default VpnControl;
