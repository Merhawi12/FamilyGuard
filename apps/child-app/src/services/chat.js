import * as SecureStore from 'expo-secure-store';
import { chat as chatApi } from './api';
import { connectSocket, onSocket, emitSocket, isSocketConnected } from './socket';

/**
 * Family chat, child side.
 *
 * The parent's Messages screen has always been able to send to the child; this
 * is the other half — reading the thread and replying, plus the emergency
 * button, which is the only way the `emergency_button` alert is ever raised.
 */

/** Fetches the thread. The child is derived from the device token. */
export async function fetchMessages() {
  const res = await chatApi.getMyMessages();
  return res.data.rows ?? res.data ?? [];
}

/**
 * Sends a message.
 *
 * Prefers the socket so the parent sees it instantly and we get a delivery
 * confirmation; falls back to REST when the device is offline-ish, so a message
 * — especially an emergency one — is never silently dropped.
 */
export async function sendMessage(text, messageType = 'normal') {
  const trimmed = text?.trim();
  if (!trimmed) throw new Error('Message cannot be empty');

  if (isSocketConnected() && emitSocket('chat:send', { text: trimmed, messageType })) {
    return { viaSocket: true };
  }

  const childId = await SecureStore.getItemAsync('fg_child_id');
  if (!childId) throw new Error('This device is not linked yet');

  await chatApi.sendFromChild(childId, { text: trimmed, messageType });
  return { viaSocket: false };
}

/** Emergency messages also raise a high-severity alert on the parent side. */
export function sendEmergency(text = 'Emergency — I need help') {
  return sendMessage(text, 'emergency');
}

/** Subscribe to incoming messages. Returns an unsubscribe function. */
export async function onMessage(handler) {
  await connectSocket();
  return onSocket('chat:message', handler);
}

/** Subscribe to delivery confirmations for messages this device sent. */
export function onDelivered(handler) {
  return onSocket('chat:delivered', handler);
}
