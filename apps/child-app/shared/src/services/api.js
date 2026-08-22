import axios from 'axios';
import { getDeviceToken, handleAuthFailure } from './link';

// The child device talks to the API hostname directly rather than through the
// app hostnames that front the web apps.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.parentix.ca/api';

/**
 * Which backend this build talks to, as a bare hostname.
 *
 * `EXPO_PUBLIC_API_URL` is inlined at bundle time, so a build is pinned to one
 * environment for life and nothing on screen ever said which. That is invisible
 * until it matters, and where it matters is linking: a code is a row in one
 * database, so a parent whose app is pointed at a different deployment hands
 * over a perfectly well-formed code that this device's server has genuinely
 * never seen. The result is an eternal "Invalid linking code" with no defect
 * anywhere in the code — the two halves are simply talking to different places.
 *
 * Exported so the link screen can show it, which turns that into something a
 * person can see and compare rather than guess at.
 */
// Parsed by hand rather than with `URL`: React Native ships an incomplete
// polyfill for it, and a display string must never be the thing that throws
// inside the client every screen depends on.
export const API_HOST = API_URL
  .replace(/^[a-z]+:\/\//i, '')
  .replace(/\/.*$/, '');

/**
 * A timeout matters more here than in the browser: this client runs inside
 * background tasks on a phone that is regularly on a half-connected network,
 * and a request that never settles would stall the monitoring loop until the
 * OS killed the task. Failing fast lets the next sync retry.
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
 * There was no response interceptor here at all, which is why a device removed
 * by its parent went on running: every call answered 401, every caller logged a
 * warning and retried on its own schedule, and the phone stayed on Home showing
 * a green "Linked" badge and enforcing whichever rules it had cached — for as
 * long as the child kept the app installed.
 *
 * Only `device_unlinked` discards anything. `account_suspended` — a blocked
 * parent, a deactivated child — is temporary and outside the child's control,
 * and forgetting the credential there would require a new code from an account
 * that cannot currently sign in to produce one; those requests are left to fail
 * and retry, which is what they did before.
 *
 * The rejection is passed through untouched. Callers already handle their own
 * failures, and swallowing it here would turn a dead request into a silent
 * success somewhere upstream.
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
  // Returns { device, deviceToken } — store deviceToken for all future calls
  confirmLink: (code) => api.post('/devices/confirm', { code }),

  // Device-authenticated calls
  getRules: () => api.get('/devices/me/rules'),
  // The child is derived from the device token, so no id is sent — the device
  // cannot ask for another child's contacts even by mistake.
  getContacts: () => api.get('/devices/me/contacts'),
  heartbeat: () => api.post('/devices/me/heartbeat'),
  logActivity: (data) => api.post('/devices/me/activity', data),
  logWebHistory: (visits) => api.post('/devices/me/web-history', { visits }),
  registerPushToken: (token, label) => api.post('/devices/me/push-token', { token, label }),
  removePushToken: (token) => api.delete('/devices/me/push-token', { data: { token } }),
};

// ── Location ─────────────────────────────────────────────────────────────────
export const location = {
  // Device-authenticated: the server derives childId and deviceId from the
  // device token, so neither may be supplied in the body.
  post: (data) => api.post('/locations', data),
};

// ── Family chat ──────────────────────────────────────────────────────────────
export const chat = {
  /** This device's own thread — the child comes from the device token. */
  getMyMessages: (params) => api.get('/chats/me/messages', { params }),
  /** REST fallback when the socket is down. `childId` is ignored by the server. */
  sendFromChild: (childId, data) => api.post(`/chats/${childId}/messages/from-child`, data),
};

export default api;
