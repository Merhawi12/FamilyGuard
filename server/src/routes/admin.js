const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/roleCheck');
const {
  listClients, toggleBlock, updatePlan, deleteClient,
  listUsers, createUser, updateUser, updateRole, approveUser,
} = require('../controllers/adminController');
const {
  listActiveSessions, listUserSessions, forceLogoutSession, forceLogoutUser,
} = require('../controllers/adminSessionController');
const { listTransactions, listUserTransactions } = require('../controllers/adminBillingController');
const { getSettings, updateSettings } = require('../controllers/settingsController');
const { getAnalytics } = require('../controllers/adminAnalyticsController');

router.use(authenticate, requireRole('admin', 'support'));

// Users
router.get('/clients', listClients);
router.get('/users', requirePermission('manage_users'), listUsers);
router.post('/users', requirePermission('manage_users'), createUser);
router.put('/users/:id', requirePermission('manage_users'), updateUser);
router.patch('/users/:id/role', requirePermission('manage_users'), updateRole);
router.patch('/users/:id/approve', requirePermission('manage_users'), approveUser);
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
