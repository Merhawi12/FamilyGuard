const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireStaff, requireSuperAdmin, requirePermission } = require('../middleware/roleCheck');
const {
  listStaff, createStaff, updateStaff, setStaffStatus, resetStaffPassword, deleteStaff,
} = require('../controllers/staffController');
const {
  listClients, toggleBlock, updatePlan, deleteClient,
  listUsers, createUser, updateUser, updateRole, approveUser, resetUserPassword,
} = require('../controllers/adminController');
const {
  listActiveSessions, listUserSessions, forceLogoutSession, forceLogoutUser,
} = require('../controllers/adminSessionController');
const { listTransactions, listUserTransactions } = require('../controllers/adminBillingController');
const { listDevices } = require('../controllers/adminDeviceController');
const { getSettings, updateSettings } = require('../controllers/settingsController');
const { getContentFiltering, updateContentFiltering } = require('../controllers/adminContentController');
const {
  listMessages, updateMessage, resendNotification,
} = require('../controllers/contactMessageController');
const { getAnalytics } = require('../controllers/adminAnalyticsController');
const {
  getPlatformHealth, acknowledgeCritical, updateAlertDelivery,
} = require('../controllers/adminHealthController');

router.use(authenticate, requireStaff);

// Staff accounts — Super Admin only, so a department account can never grant
// itself privileges it was not given.
router.get('/staff', requireSuperAdmin, listStaff);
router.post('/staff', requireSuperAdmin, createStaff);
router.put('/staff/:id', requireSuperAdmin, updateStaff);
router.patch('/staff/:id/status', requireSuperAdmin, setStaffStatus);
router.post('/staff/:id/reset-password', requireSuperAdmin, resetStaffPassword);
router.delete('/staff/:id', requireSuperAdmin, deleteStaff);

// Users
//
// `/clients` is the unpaginated ancestor of `/users` and returns every customer's
// name, email, plan and status in one array. It was the only route in this file
// carrying no permission beyond `requireStaff`, which meant a Marketing or
// Finance account — neither of which can open the Users screen, and neither of
// which is shown a link to this — could still enumerate the entire customer base
// by calling it directly. Its own siblings just below all require manage_users,
// and so does the paginated `/users` that replaced it.
//
// Gated rather than deleted: nothing in this repo calls it, but an older console
// build still in someone's browser tab might, and a 403 is a better answer to
// that than a 404.
router.get('/clients', requirePermission('manage_users'), listClients);
router.get('/users', requirePermission('manage_users'), listUsers);
router.post('/users', requirePermission('manage_users'), createUser);
router.put('/users/:id', requirePermission('manage_users'), updateUser);
// Crossing the staff boundary is a privilege change, not user administration.
router.patch('/users/:id/role', requireSuperAdmin, updateRole);
router.patch('/users/:id/approve', requirePermission('manage_users'), approveUser);
// Taking over an account is gated separately from editing one.
router.post('/users/:id/reset-password', requirePermission('reset_passwords'), resetUserPassword);
router.patch('/clients/:id/toggle-block', requirePermission('manage_users'), toggleBlock);
router.patch('/clients/:id/plan', requirePermission('manage_users'), updatePlan);
router.delete('/clients/:id', requirePermission('manage_users'), deleteClient);

// Sessions
router.get('/sessions/active', requirePermission('manage_sessions'), listActiveSessions);
router.get('/users/:id/sessions', requirePermission('manage_sessions'), listUserSessions);
router.delete('/sessions/:sessionId', requirePermission('manage_sessions'), forceLogoutSession);
router.delete('/users/:id/sessions', requirePermission('manage_sessions'), forceLogoutUser);

// Devices — a device belongs to a customer account, so the directory permission
// is the one that governs reading it. Read-only: enrolling and removing a device
// stays with the parent who owns it.
router.get('/devices', requirePermission('manage_users'), listDevices);

// Billing
router.get('/transactions', requirePermission('manage_billing'), listTransactions);
router.get('/users/:id/transactions', requirePermission('manage_billing'), listUserTransactions);

// Settings
router.get('/settings', requirePermission('manage_settings'), getSettings);
router.put('/settings', requirePermission('manage_settings'), updateSettings);

// Content filtering — the platform-wide policy every device is subject to. It
// configures the platform, so it is gated by the settings permission rather
// than by the directory one that opens a customer's own rules.
router.get('/content-filtering', requirePermission('manage_settings'), getContentFiltering);
router.put('/content-filtering', requirePermission('manage_settings'), updateContentFiltering);

// The public contact form's inbox. Its own permission rather than `manage_users`
// — most of the people in it have no account — see config/roles.js.
router.get('/contact-messages', requirePermission('view_contact_messages'), listMessages);
router.patch('/contact-messages/:id', requirePermission('view_contact_messages'), updateMessage);
router.post('/contact-messages/:id/resend', requirePermission('view_contact_messages'), resendNotification);

// Analytics
router.get('/analytics', getAnalytics);

// Platform health — the Overview's alert summary. It reads the audit stream, so
// it is gated by the same permission that opens System Logs; an account without
// it gets the Overview's analytics and no alert panel.
router.get('/platform-health', requirePermission('view_audit_logs'), getPlatformHealth);
router.post('/platform-health/acknowledge', requirePermission('view_audit_logs'), acknowledgeCritical);
// Holding an alert type back from email and push changes how the platform
// behaves for every family on it, which is a settings decision.
router.put('/platform-health/alert-delivery', requirePermission('manage_settings'), updateAlertDelivery);

module.exports = router;
