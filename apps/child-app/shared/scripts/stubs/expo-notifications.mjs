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

export default notificationsStub;
