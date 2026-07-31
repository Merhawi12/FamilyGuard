const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireStaff, requirePermission } = require('../middleware/roleCheck');
const { getLogs } = require('../controllers/auditController');

router.use(authenticate, requireStaff, requirePermission('view_audit_logs'));
router.get('/', getLogs);

module.exports = router;
