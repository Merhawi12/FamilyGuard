const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/roleCheck');
const { getLogs } = require('../controllers/auditController');

router.use(authenticate, requireRole('admin', 'support'), requirePermission('view_audit_logs'));
router.get('/', getLogs);

module.exports = router;
