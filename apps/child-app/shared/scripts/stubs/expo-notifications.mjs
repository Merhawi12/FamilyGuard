import { notificationsStub } from './platform.mjs';

export const AndroidImportance = notificationsStub.AndroidImportance;
export const setNotificationHandler = notificationsStub.setNotificationHandler;
export const setNotificationChannelAsync = notificationsStub.setNotificationChannelAsync;
export const getPermissionsAsync = notificationsStub.getPermissionsAsync;
export const requestPermissionsAsync = notificationsStub.requestPermissionsAsync;
export const getExpoPushTokenAsync = notificationsStub.getExpoPushTokenAsync;
export const addNotificationReceivedListener = notificationsStub.addNotificationReceivedListener;
export const addNotificationResponseReceivedListener = notificationsStub.addNotificationResponseReceivedListener;
export const getLastNotificationResponseAsync = notificationsStub.getLastNotificationResponseAsync;
// The screen-time warning. Named explicitly like the rest: `push.js` imports the
// module namespace, so a function missing from this list is missing from the app
// — which is how the first run of the warning check failed rather than passing.
export const scheduleNotificationAsync = notificationsStub.scheduleNotificationAsync;

export default notificationsStub;
