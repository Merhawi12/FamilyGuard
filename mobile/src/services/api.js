import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const API_URL = 'http://18.226.58.189/api';

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
  // No auth required — childId + deviceId in body identify the device
  post: (data) => api.post('/locations', data),
};

export default api;
