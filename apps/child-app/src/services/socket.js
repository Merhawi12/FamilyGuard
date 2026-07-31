import * as SecureStore from 'expo-secure-store';
import { io } from 'socket.io-client';

const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || 'https://api.parentix.ca';

/**
 * The device's single Socket.IO connection.
 *
 * Rules sync and family chat both need realtime, and opening a socket per
 * feature would mean two authenticated connections per device. This owns the
 * one connection; features subscribe through `on`.
 *
 * The handshake carries the device token — the server derives the child and
 * parent identity from it and joins the rooms itself, so nothing here sends ids.
 */
let _socket = null;

/** Listeners registered before the socket exists, re-applied on connect. */
const _pending = [];

export async function connectSocket() {
  if (_socket) return _socket;

  const token = await SecureStore.getItemAsync('fg_device_token');
  if (!token) return null;

  _socket = io(SOCKET_URL, {
    transports: ['websocket'],
    auth: { token },
    // The device is expected to be offline regularly; keep trying rather than
    // giving up and leaving the parent without realtime updates.
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  for (const [event, handler] of _pending) _socket.on(event, handler);

  return _socket;
}

export function onSocket(event, handler) {
  _pending.push([event, handler]);
  _socket?.on(event, handler);
  return () => offSocket(event, handler);
}

export function offSocket(event, handler) {
  const index = _pending.findIndex(([e, h]) => e === event && h === handler);
  if (index !== -1) _pending.splice(index, 1);
  _socket?.off(event, handler);
}

/** No-op until connected — callers do not have to care about socket state. */
export function emitSocket(event, data = {}) {
  if (_socket?.connected) {
    _socket.emit(event, data);
    return true;
  }
  return false;
}

export function isSocketConnected() {
  return !!_socket?.connected;
}

export function disconnectSocket() {
  _socket?.disconnect();
  _socket = null;
  _pending.length = 0;
}
