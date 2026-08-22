import { locationStub } from './platform.mjs';

export const Accuracy = locationStub.Accuracy;
// Named one by one rather than re-exported wholesale, so anything the app reaches
// for that the stub has not thought about fails here rather than silently. That
// is working as intended and it is why adding `ActivityType` to platform.mjs was
// not enough on its own — `monitoring.js` imports this module as a namespace, so
// a name missing from *this* file reads as `undefined` no matter what the stub
// object holds.
export const ActivityType = locationStub.ActivityType;
export const getForegroundPermissionsAsync = locationStub.getForegroundPermissionsAsync;
export const getBackgroundPermissionsAsync = locationStub.getBackgroundPermissionsAsync;
export const requestForegroundPermissionsAsync = locationStub.requestForegroundPermissionsAsync;
export const requestBackgroundPermissionsAsync = locationStub.requestBackgroundPermissionsAsync;
export const startLocationUpdatesAsync = locationStub.startLocationUpdatesAsync;
export const stopLocationUpdatesAsync = locationStub.stopLocationUpdatesAsync;
export default locationStub;
