import api from './client.js';

/**
 * Every call the two web apps make, in one place.
 *
 * These are object literals, which is worth knowing before adding to them: a
 * bundler cannot drop one property of an object it keeps, so an entry nothing
 * calls is shipped to every browser that touches its group. Seven such entries
 * were removed in one pass — bindings for `POST /activity` and
 * `POST /devices/confirm` (both written by the *device* agents, which have their
 * own client in apps/child-app and apps/child-desktop and never load this file),
 * `GET /locations/:id/history`, and four admin routes that outlived the screens
 * that called them. Each of those server routes still exists and still answers;
 * only the unused client binding went.
 *
 * So: add a binding when a screen is ready to call it, not in advance.
 */
export const auth = {
  register: (data) => api.post('/auth/register', data),
  verifyEmail: (data) => api.post('/auth/verify-email', data),
  resendCode: (data) => api.post('/auth/resend-code', data),
  login: (data) => api.post('/auth/login', data),
  /**
   * Sign in with Google. `credential` is the ID token Google Identity Services
   * hands the page — the API verifies its signature and audience, so nothing
   * here has to be trusted. Registers on first use and signs in thereafter.
   */
  google: (credential) => api.post('/auth/google', { credential }),
  /** Which sign-in methods this deployment offers, so the page can ask. */
  providers: () => api.get('/auth/providers'),
  /**
   * Phone sign-in, in two steps.
   *
   * `mode` is 'register' or 'login' and decides what a number with no account
   * means — create one, or refuse. The page always knows which tab it is on, so
   * the server never has to guess and the two cases can answer differently.
   *
   * The response carries `smsDelivered`, and it is load-bearing: a deployment
   * with no SMS credentials answers false, which is what stops the code screen
   * from waiting on a message that was never going out.
   */
  requestPhoneCode: (data) => api.post('/auth/phone/request', data),
  verifyPhoneCode: (data) => api.post('/auth/phone/verify', data),
  /**
   * Forgotten password, in three calls.
   *
   * `forgotPassword` emails a 6-digit code and always answers 200 — it says
   * nothing about whether the address has an account, so the screen moves to the
   * code step either way. `verifyResetCode` exchanges those digits for a
   * single-use `resetToken`, and `resetPassword` spends it. The token is never
   * emailed: it exists only between the second call's response and the third
   * call's body.
   */
  forgotPassword: (data) => api.post('/auth/forgot-password', data),
  verifyResetCode: (data) => api.post('/auth/verify-reset-code', data),
  resetPassword: (data) => api.post('/auth/reset-password', data),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  /** Own profile: `{ name?, email? }`. */
  updateProfile: (data) => api.put('/auth/profile', data),
  /** Own password: `{ currentPassword, newPassword }`. */
  changePassword: (data) => api.put('/auth/password', data),
  getNotificationPrefs: () => api.get('/auth/notification-prefs'),
  updateNotificationPrefs: (data) => api.put('/auth/notification-prefs', data),
  /** Own sessions, so the "signed in from a new device" email has a follow-up. */
  sessions: () => api.get('/auth/sessions'),
  revokeSession: (id) => api.delete(`/auth/sessions/${id}`),
  revokeOtherSessions: () => api.delete('/auth/sessions/others'),
  /**
   * Close the account for good. `{ password }` for an account that has one,
   * `{ confirm: 'DELETE' }` for one signed in with Google or a phone number.
   */
  deleteAccount: (data) => api.delete('/auth/account', { data }),
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
  // A fresh code for a device that was created but never connected.
  regenerateLink: (id) => api.post(`/devices/${id}/link`),
  update: (id, data) => api.patch(`/devices/${id}`, data),
  // Pausing one device. Not the same as `remove`, which cannot be undone — see
  // the API's utils/deviceAccess.js.
  block: (id) => api.post(`/devices/${id}/block`),
  unblock: (id) => api.post(`/devices/${id}/unblock`),
  remove: (id) => api.delete(`/devices/${id}`),
};

export const screenTime = {
  /**
   * `deviceId` is optional throughout. Omitted, these read and write the child's
   * rule — every device they own obeys it, which is what this page did before
   * per-device limits existed. Given one, they read and write that device's
   * exception, which overrides the child's rule for that device alone.
   */
  get: (childId, deviceId) => api.get(`/screen-time/${childId}`, { params: deviceId ? { deviceId } : undefined }),
  update: (childId, data, deviceId) =>
    api.put(`/screen-time/${childId}`, data, { params: deviceId ? { deviceId } : undefined }),
  // Drops a device's exception so it follows the child's rule again.
  clearDeviceRule: (childId, deviceId) =>
    api.delete(`/screen-time/${childId}`, { params: { deviceId } }),
};

export const blocking = {
  getApps: (childId) => api.get(`/blocking/${childId}/apps`),
  // The apps this child's devices have reported using, so the rule form can
  // offer a real package name instead of asking a parent to know one.
  knownApps: (childId) => api.get(`/blocking/${childId}/apps/known`),
  addApp: (childId, data) => api.post(`/blocking/${childId}/apps`, data),
  removeApp: (childId, ruleId) => api.delete(`/blocking/${childId}/apps/${ruleId}`),
  getWebsites: (childId) => api.get(`/blocking/${childId}/websites`),
  addWebsite: (childId, data) => api.post(`/blocking/${childId}/websites`, data),
  removeWebsite: (childId, ruleId) => api.delete(`/blocking/${childId}/websites/${ruleId}`),
};

export const activity = {
  get: (childId, params) => api.get(`/activity/${childId}`, { params }),
  webHistory: (childId, params) => api.get(`/activity/${childId}/web-history`, { params }),

  /**
   * Deleting recorded activity.
   *
   * Web History and the Activity Log read the same table — a browsing row is an
   * activity row — so `removeEntry` serves both screens, and clearing either one
   * is visible on the other. The API's activityController explains the whole of
   * it; the confirmation copy on both pages says it in words.
   *
   * The two clears take `{ from, to }` so they remove what the screen is
   * showing rather than silently all of history.
   */
  removeEntry: (childId, entryId) => api.delete(`/activity/${childId}/entries/${entryId}`),
  clearWebHistory: (childId, params) => api.delete(`/activity/${childId}/web-history`, { params }),
  clear: (childId, params) => api.delete(`/activity/${childId}`, { params }),
};

export const reports = {
  daily: (childId, date) => api.get(`/reports/${childId}/daily`, { params: { date } }),
  weekly: (childId) => api.get(`/reports/${childId}/weekly`),
  // Every child's week, summed, in one request — what the dashboard's chart
  // needs. Calling `weekly` once per child instead made the home screen's load
  // time scale with the size of the family.
  familyWeekly: () => api.get('/reports/weekly'),
};

export const alerts = {
  list: (unreadOnly) => api.get('/alerts', { params: { unreadOnly } }),
  markRead: (id) => api.put(`/alerts/${id}/read`),
  markAllRead: () => api.put('/alerts/read-all'),
  remove: (id) => api.delete(`/alerts/${id}`),
  // Takes the same filters the list does, so a clear removes what the screen is
  // showing. No filters clears everything the account owns.
  clear: (params) => api.delete('/alerts', { params }),
};

export const notifications = {
  list: () => api.get('/notifications'),
  markRead: (id) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),

  // Push. `config` reports whether the deployment can deliver at all — VAPID
  // keys for a browser, FCM for the Android app — so the settings screen can say
  // "unavailable" instead of failing on subscribe.
  pushConfig: () => api.get('/notifications/push/config'),
  pushSubscriptions: () => api.get('/notifications/push/subscriptions'),
  /**
   * `platform` defaults server-side to 'web', so a browser passes a subscription
   * object and nothing else. The Android app passes its FCM registration token
   * and 'fcm' — same endpoint, same account, different transport.
   */
  pushSubscribe: (subscription, label, platform) =>
    api.post('/notifications/push/subscribe', { subscription, label, ...(platform && { platform }) }),
  pushUnsubscribe: (subscription) => api.post('/notifications/push/unsubscribe', { subscription }),
  pushRemoveSubscription: (id) => api.delete(`/notifications/push/subscriptions/${id}`),
  pushTest: () => api.post('/notifications/push/test'),
};

export const chats = {
  getMessages: (childId, params) => api.get(`/chats/${childId}/messages`, { params }),
  sendMessage: (childId, data) => api.post(`/chats/${childId}/messages`, data),
};

export const locations = {
  getCurrent: (childId) => api.get(`/locations/${childId}/current`),
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

/**
 * The public contact form. Unauthenticated by design — someone who cannot sign
 * in has to be able to say so — and rate limited to 5 per 15 minutes per IP.
 * The in-app Support screen posts here too, so both doors reach one inbox and
 * one spam classifier.
 */
export const contactForm = {
  send: (data) => api.post('/contact', data),
};

export const uploads = {
  /** Mints a short-lived pre-signed Cloud Storage PUT URL for a child profile photo. */
  childAvatar: (data) => api.post('/uploads/child-avatar', data),
};

/** Staff-only surface — every call is additionally gated server-side by role. */
export const admin = {
  toggleBlock: (id) => api.patch(`/admin/clients/${id}/toggle-block`),
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
  forceLogoutSession: (sessionId) => api.delete(`/admin/sessions/${sessionId}`),
  forceLogoutUser: (id) => api.delete(`/admin/users/${id}/sessions`),

  /** The whole device fleet: `{ search, platform, status, limit, offset }`. */
  listDevices: (params) => api.get('/admin/devices', { params }),

  /**
   * The payment log: `{ search, status, plan, userId, limit, offset }`, answering
   * `{ rows, count, summary }`. `summary` is platform-wide and ignores every
   * filter — it describes the business, not the page.
   */
  listTransactions: (params) => api.get('/admin/transactions', { params }),

  getSettings: () => api.get('/admin/settings'),
  updateSettings: (data) => api.put('/admin/settings', data),

  /**
   * The platform-wide filtering policy, its catalogue and what the fleet did
   * with it. The update takes the whole policy — `{ categories, domainRules }` —
   * because a patch of one switch would need the client to hold the rest.
   */
  getContentFiltering: () => api.get('/admin/content-filtering'),
  updateContentFiltering: (data) => api.put('/admin/content-filtering', data),

  getAnalytics: () => api.get('/admin/analytics'),

  /**
   * The Overview's alert panel: severity counts over a window, the newest
   * critical entry, the channels alerts can leave by, and which alert types are
   * held back from email and push. Needs `view_audit_logs`.
   */
  getPlatformHealth: (params) => api.get('/admin/platform-health', { params }),
  acknowledgeCritical: (entryId) => api.post('/admin/platform-health/acknowledge', { entryId }),
  updateAlertDelivery: (muted) => api.put('/admin/platform-health/alert-delivery', { muted }),

  sendNotification: (data) => api.post('/notifications', data),
  listSentNotifications: (params) => api.get('/notifications/sent', { params }),

  getAuditLogs: (params) => api.get('/audit', { params }),
};
