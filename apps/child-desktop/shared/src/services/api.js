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

/**
 * Samples per activity request. Mirrors `MAX_SAMPLES_PER_BATCH` in
 * services/api/src/controllers/deviceController.js, which refuses anything
 * larger.
 */
const MAX_ACTIVITY_BATCH = 200;

/**
 * Is the backend reachable from this machine at all?
 *
 * Unauthenticated on purpose — it is asked during first-run setup, before this
 * computer has a credential, and its whole job is to separate "the network is
 * not working" from "that code was not recognised". Those two produce the same
 * screen otherwise, and only one of them is fixed by plugging in a cable.
 */
export const health = () => api.get('/health');

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
  /**
   * Today's totals for every app, in one request.
   *
   * `uploadUsage` sent these one at a time in an awaited loop, which on a laptop
   * that has been open all day is dozens of sequential round trips per upload
   * pass. Chunked at the server's own `MAX_SAMPLES_PER_BATCH` so a machine with
   * an unusually long app list degrades into two requests rather than a 400 and
   * a day of missing usage.
   */
  logActivityBatch: async (samples) => {
    let last;
    for (let i = 0; i < samples.length; i += MAX_ACTIVITY_BATCH) {
      last = await api.post('/devices/me/activity/batch', {
        samples: samples.slice(i, i + MAX_ACTIVITY_BATCH),
      });
    }
    return last;
  },
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
