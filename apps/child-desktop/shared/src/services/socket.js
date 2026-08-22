import { io } from 'socket.io-client';
import { getDeviceToken, handleAuthFailure, handleUnlinked } from './link.js';

const SOCKET_URL = process.env.PARENTIX_SOCKET_URL
  || (process.env.PARENTIX_API_URL || 'https://api.parentix.ca/api').replace(/\/api\/?$/, '');

/**
 * The agent's single Socket.IO connection.
 *
 * Rules sync, contact sync and family chat all need realtime, and a socket per
 * feature would mean three authenticated connections per laptop. This owns the
 * one; features subscribe through `on`.
 *
 * The handshake carries the device token — the server derives the child and
 * parent identity from it and joins the rooms itself, so nothing here sends ids.
 *
 * **This runs in Node, and that is the reason it needs no server change.**
 * socket.io-client under Node sends no `Origin` header, and the API's socket
 * CORS delegate allows an origin-less caller. The mobile app is the awkward one:
 * React Native's WebSocket injects `Origin: https://api.parentix.ca` — the host
 * it is dialling — which is why the API grew an explicit "an origin naming this
 * host is allowed on the socket, but not on REST" rule. Nothing here depends on
 * that rule, so nothing here breaks if it changes.
 */
let _socket = null;

/** Listeners registered before the socket exists, re-applied on connect. */
const _pending = [];

export async function connectSocket() {
  if (_socket) return _socket;

  const token = await getDeviceToken();
  if (!token) return null;

  _socket = io(SOCKET_URL, {
    transports: ['websocket'],
    auth: { token },
    // A laptop is closed, carried and reopened; keep trying rather than giving
    // up and leaving the parent without realtime updates until a restart.
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  /** The parent removed this device while it was connected. */
  _socket.on('device:unlinked', () => handleUnlinked());

  /**
   * And the same news for a machine that was asleep when it happened: the
   * handshake refuses the reconnect and carries the reason in `err.data.code`.
   * Without this the client would retry that refusal every 30 seconds for the
   * life of the install.
   */
  _socket.on('connect_error', (err) => handleAuthFailure(err?.data?.code));

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
