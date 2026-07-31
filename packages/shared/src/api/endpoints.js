import api from './client.js';

export const auth = {
  register: (data) => api.post('/auth/register', data),
  verifyEmail: (data) => api.post('/auth/verify-email', data),
  resendCode: (data) => api.post('/auth/resend-code', data),
  login: (data) => api.post('/auth/login', data),
  forgotPassword: (data) => api.post('/auth/forgot-password', data),
  resetPassword: (data) => api.post('/auth/reset-password', data),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  /** Own profile: `{ name?, email? }`. */
  updateProfile: (data) => api.put('/auth/profile', data),
  /** Own password: `{ currentPassword, newPassword }`. */
  changePassword: (data) => api.put('/auth/password', data),
  getNotificationPrefs: () => api.get('/auth/notification-prefs'),
  updateNotificationPrefs: (data) => api.put('/auth/notification-prefs', data),
};

export const mfa = {
  setup: () => api.post('/auth/mfa/setup'),
  enable: (data) => api.post('/auth/mfa/enable', data),
  disable: (data) => api.post('/auth/mfa/disable', data),
  /** Second login step: `{ preAuthToken, code }` → full session token. */
  validate: (data) => api.post('/auth/mfa/validate', data),
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

export const notifications = {
  list: () => api.get('/notifications'),
  markRead: (id) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),
};

export const chats = {
  getMessages: (childId, params) => api.get(`/chats/${childId}/messages`, { params }),
  sendMessage: (childId, data) => api.post(`/chats/${childId}/messages`, data),
};

export const locations = {
  getCurrent: (childId) => api.get(`/locations/${childId}/current`),
  getHistory: (childId, params) => api.get(`/locations/${childId}/history`, { params }),
  /** Parent-set position: `{ latitude, longitude, accuracy?, address? }`. */
  setManual: (childId, data) => api.post(`/locations/${childId}/manual`, data),
};

export const safeZones = {
  list: (childId) => api.get('/safe-zones', { params: childId ? { childId } : {} }),
  create: (data) => api.post('/safe-zones', data),
  update: (id, data) => api.put(`/safe-zones/${id}`, data),
  remove: (id) => api.delete(`/safe-zones/${id}`),
};

export const payments = {
  createCheckoutSession: (plan) => api.post('/payments/create-checkout-session', { plan }),
  customerPortal: () => api.post('/payments/customer-portal'),
  getSubscription: () => api.get('/payments/subscription'),
};

export const contacts = {
  list: (childId) => api.get('/contacts', { params: childId ? { childId } : {} }),
  create: (data) => api.post('/contacts', data),
  update: (id, data) => api.put(`/contacts/${id}`, data),
  remove: (id) => api.delete(`/contacts/${id}`),
};

export const contactForm = {
  send: (data) => api.post('/contact', data),
};

export const uploads = {
  /** Mints a short-lived pre-signed S3 PUT URL for a child profile photo. */
  childAvatar: (data) => api.post('/uploads/child-avatar', data),
};

/** Staff-only surface — every call is additionally gated server-side by role. */
export const admin = {
  listClients: () => api.get('/admin/clients'),
  toggleBlock: (id) => api.patch(`/admin/clients/${id}/toggle-block`),
  updatePlan: (id, plan) => api.patch(`/admin/clients/${id}/plan`, { plan }),
  deleteClient: (id) => api.delete(`/admin/clients/${id}`),

  /** Staff accounts — Super Admin only. */
  listStaff: () => api.get('/admin/staff'),
  createStaff: (data) => api.post('/admin/staff', data),
  updateStaff: (id, data) => api.put(`/admin/staff/${id}`, data),
  setStaffStatus: (id, isActive) => api.patch(`/admin/staff/${id}/status`, { isActive }),
  resetStaffPassword: (id, data = {}) => api.post(`/admin/staff/${id}/reset-password`, data),
  deleteStaff: (id) => api.delete(`/admin/staff/${id}`),

  listUsers: (params) => api.get('/admin/users', { params }),
  createUser: (data) => api.post('/admin/users', data),
  updateUser: (id, data) => api.put(`/admin/users/${id}`, data),
  updateRole: (id, data) => api.patch(`/admin/users/${id}/role`, data),
  approveUser: (id) => api.patch(`/admin/users/${id}/approve`),
  /** Customer password reset. `{ password }` sets it; omit to generate one. */
  resetUserPassword: (id, data = {}) => api.post(`/admin/users/${id}/reset-password`, data),

  listActiveSessions: (params) => api.get('/admin/sessions/active', { params }),
  listUserSessions: (id) => api.get(`/admin/users/${id}/sessions`),
  forceLogoutSession: (sessionId) => api.delete(`/admin/sessions/${sessionId}`),
  forceLogoutUser: (id) => api.delete(`/admin/users/${id}/sessions`),

  listTransactions: (params) => api.get('/admin/transactions', { params }),
  listUserTransactions: (id) => api.get(`/admin/users/${id}/transactions`),

  getSettings: () => api.get('/admin/settings'),
  updateSettings: (data) => api.put('/admin/settings', data),

  getAnalytics: () => api.get('/admin/analytics'),

  sendNotification: (data) => api.post('/notifications', data),
  listSentNotifications: (params) => api.get('/notifications/sent', { params }),

  getAuditLogs: (params) => api.get('/audit', { params }),
};
