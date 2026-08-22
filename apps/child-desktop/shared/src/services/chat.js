import { chat as chatApi } from './api.js';
import { getChildId } from './link.js';
import { connectSocket, onSocket, emitSocket, isSocketConnected } from './socket.js';

/**
 * Family chat, child side — the same thread the phone shows, on the laptop.
 *
 * Worth having on a desktop for a reason the phone version does not have: the
 * lock screen. When bedtime arrives mid-homework the only reasonable thing a
 * child can do is ask, and "Ask for more time" sends a message here rather than
 * leaving them with a locked screen and no recourse.
 */

/** Fetches the thread. The child is derived from the device token. */
export async function fetchMessages(params) {
  const res = await chatApi.getMyMessages(params);
  return res.data.rows ?? res.data ?? [];
}

/**
 * Sends a message.
 *
 * Prefers the socket so the parent sees it instantly and we get a delivery
 * confirmation; falls back to REST when the machine is offline-ish, so a message
 * — especially an emergency one — is never silently dropped.
 */
export async function sendMessage(text, messageType = 'normal') {
  const trimmed = text?.trim();
  if (!trimmed) throw new Error('Message cannot be empty');

  if (isSocketConnected() && emitSocket('chat:send', { text: trimmed, messageType })) {
    return { viaSocket: true };
  }

  const childId = await getChildId();
  if (!childId) throw new Error('This computer is not linked yet');

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
