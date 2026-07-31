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
const { getSettings, updateSettings } = require('../controllers/settingsController');
const { getAnalytics } = require('../controllers/adminAnalyticsController');

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
router.get('/clients', listClients);
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

// Billing
router.get('/transactions', requirePermission('manage_billing'), listTransactions);
router.get('/users/:id/transactions', requirePermission('manage_billing'), listUserTransactions);

// Settings
router.get('/settings', requirePermission('manage_settings'), getSettings);
router.put('/settings', requirePermission('manage_settings'), updateSettings);

// Analytics
router.get('/analytics', getAnalytics);

module.exports = router;
