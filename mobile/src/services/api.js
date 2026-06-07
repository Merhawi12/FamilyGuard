import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const API_URL = 'http://YOUR_SERVER_IP:5000/api';

const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('fg_device_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const device = {
  confirmLink: (code) => api.post('/devices/confirm', { code }),
  heartbeat: (deviceId) => api.post(`/devices/${deviceId}/heartbeat`, {}),
};

export const activity = {
  log: (data) => api.post('/activity', data),
};

export default api;
