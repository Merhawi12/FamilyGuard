import axios from 'axios';

const api = axios.create({ baseURL: '/api', withCredentials: true });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('fg_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('fg_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export const auth = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
  me: () => api.get('/auth/me'),
};

export const children = {
  list: () => api.get('/children'),
  create: (data) => api.post('/children', data),
  update: (id, data) => api.put(`/children/${id}`, data),
  remove: (id) => api.delete(`/children/${id}`),
};

export const devices = {
  list: () => api.get('/devices'),
  generateLink: (data) => api.post('/devices/link', data),
  confirmLink: (data) => api.post('/devices/confirm', data),
  remove: (id) => api.delete(`/devices/${id}`),
};

export const screenTime = {
  get: (childId) => api.get(`/screen-time/${childId}`),
  update: (childId, data) => api.put(`/screen-time/${childId}`, data),
};

export const blocking = {
  getApps: (childId) => api.get(`/blocking/${childId}/apps`),
  addApp: (childId, data) => api.post(`/blocking/${childId}/apps`, data),
  removeApp: (childId, ruleId) => api.delete(`/blocking/${childId}/apps/${ruleId}`),
  getWebsites: (childId) => api.get(`/blocking/${childId}/websites`),
  addWebsite: (childId, data) => api.post(`/blocking/${childId}/websites`, data),
  removeWebsite: (childId, ruleId) => api.delete(`/blocking/${childId}/websites/${ruleId}`),
};

export const activity = {
  get: (childId, params) => api.get(`/activity/${childId}`, { params }),
  log: (data) => api.post('/activity', data),
};

export const reports = {
  daily: (childId, date) => api.get(`/reports/${childId}/daily`, { params: { date } }),
  weekly: (childId) => api.get(`/reports/${childId}/weekly`),
};

export const alerts = {
  list: (unreadOnly) => api.get('/alerts', { params: { unreadOnly } }),
  markRead: (id) => api.put(`/alerts/${id}/read`),
  markAllRead: () => api.put('/alerts/read-all'),
};

export default api;
