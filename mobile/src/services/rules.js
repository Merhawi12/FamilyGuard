import * as SecureStore from 'expo-secure-store';
import { io } from 'socket.io-client';
import { device as deviceApi } from './api';

const SOCKET_URL = 'http://18.226.58.189';
const POLL_INTERVAL = 5 * 60 * 1000; // 5 min

let _rules = { appRules: [], websiteRules: [], screenTimeRule: null };
let _socket = null;
let _pollTimer = null;
let _onUpdate = null;

export function getRules() {
  return _rules;
}

export async function fetchRules() {
  try {
    const res = await deviceApi.getRules();
    _rules = res.data;
    if (_onUpdate) _onUpdate(_rules);
  } catch (e) {
    console.warn('[rules] fetch failed:', e.message);
  }
}

export async function startRulesSync(onUpdate) {
  _onUpdate = onUpdate;

  await fetchRules();

  // Poll every 5 minutes as a safety net
  _pollTimer = setInterval(fetchRules, POLL_INTERVAL);

  // Real-time socket updates
  const childId = await SecureStore.getItemAsync('fg_child_id');
  if (!childId) return;

  _socket = io(SOCKET_URL, { transports: ['websocket'] });
  _socket.on('connect', () => {
    _socket.emit('join:child', childId);
  });
  _socket.on('rules_updated', fetchRules);
  _socket.on('screen_time_updated', (rule) => {
    _rules = { ..._rules, screenTimeRule: rule };
    if (_onUpdate) _onUpdate(_rules);
  });
}

export function stopRulesSync() {
  clearInterval(_pollTimer);
  _socket?.disconnect();
  _socket = null;
}
