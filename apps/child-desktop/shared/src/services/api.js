import axios from 'axios';
import { getDeviceToken, handleAuthFailure } from './link.js';

/**
 * The agent talks to the API hostname directly, the same one the phones use —
 * one backend and one database behind all four clients.
 *
 * `PARENTIX_API_URL` is read from the environment so a development build can be
 * pointed at a local API, and the packaged installers bake production in. The
 * value is captured once, at import, and exported as a bare hostname because the
 * link window shows it: a linking code is a row in one database, so a parent
 * whose dashboard is pointed at a different deployment hands over a perfectly
 * well-formed code that this machine's server has genuinely never seen. That
 * produces an eternal "Invalid linking code" with no defect anywhere in the
 * code, and the only way anyone finds it is by comparing the two hostnames.
 */
const API_URL = process.env.PARENTIX_API_URL || 'https://api.parentix.ca/api';

export const API_HOST = API_URL.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');

/**
 * A timeout matters here for the same reason it does on the phone: this client
 * runs inside timers on a laptop that is regularly suspended, on hotel Wi-Fi and
 * behind captive portals, and a request that never settles would stall the sync
 * loop it is part of. Failing fast lets the next pass retry.
 */
const api = axios.create({ baseURL: API_URL, timeout: 20000 });

api.interceptors.request.use(async (config) => {
  const token = await getDeviceToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * A device token the server will never accept again.
 *
 * Only `device_unlinked` discards anything. `account_suspended` — a blocked
 * parent, a deactivated child — is temporary and outside the child's control,
 * and forgetting the credential there would need a new code from an account that
 * cannot currently sign in to produce one.
 *
 * The rejection is passed through untouched: callers handle their own failures,
 * and swallowing it here would turn a dead request into a silent success
 * somewhere upstream.
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) handleAuthFailure(error.response.data?.code);
    return Promise.reject(error);
  },
);

// ── Device linking ────────────────────────────────────────────────────────────
export const device = {
  /**
   * Redeems a linking code. Returns `{ device, deviceToken }`.
   *
   * `type` is this machine telling the server what it actually is. The parent
   * chose a type when they generated the code, from a dashboard that is not in
   * front of the computer being set up — so a family with a Windows laptop and a
   * MacBook can easily hand the Mac's code to the PC. The device knows, and
   * correcting it here is what keeps the icon and the label in the parent's
   * device list honest.
   */
  confirmLink: (code, { osVersion, type } = {}) =>
    api.post('/devices/confirm', { code, osVersion, type }),

  // Device-authenticated calls. None of them send a child id: the server derives
  // it from the device token, so this machine can only ever read and write its
  // own child's data.
  getRules: () => api.get('/devices/me/rules'),
  getContacts: () => api.get('/devices/me/contacts'),
  heartbeat: () => api.post('/devices/me/heartbeat'),
  logActivity: (data) => api.post('/devices/me/activity', data),
  logWebHistory: (visits) => api.post('/devices/me/web-history', { visits }),
};

// ── Family chat ───────────────────────────────────────────────────────────────
export const chat = {
  /** This device's own thread — the child comes from the device token. */
  getMyMessages: (params) => api.get('/chats/me/messages', { params }),
  /** REST fallback when the socket is down. `childId` is ignored by the server. */
  sendFromChild: (childId, data) => api.post(`/chats/${childId}/messages/from-child`, data),
};

export default api;
