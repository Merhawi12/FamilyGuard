import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

// The child device talks to the API hostname directly rather than through the
// app hostnames that front the web apps.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.parentix.ca/api';

const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('fg_device_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Device linking ────────────────────────────────────────────────────────────
export const device = {
  // Returns { device, deviceToken } — store deviceToken for all future calls
  confirmLink: (code) => api.post('/devices/confirm', { code }),

  // Device-authenticated calls
  getRules: () => api.get('/devices/me/rules'),
  heartbeat: () => api.post('/devices/me/heartbeat'),
  logActivity: (data) => api.post('/devices/me/activity', data),
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
