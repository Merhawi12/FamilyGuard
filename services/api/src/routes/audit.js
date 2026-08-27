const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireStaff, requirePermission } = require('../middleware/roleCheck');
const { getLogs, removeEntry, clearLogs } = require('../controllers/auditController');

router.use(authenticate, requireStaff, requirePermission('view_audit_logs'));
router.get('/', getLogs);

/**
 * Deleting needs a second permission on top of the one above.
 *
 * `view_audit_logs` is held by Operations too, and reading the stream is the
 * ordinary case. Removing from it is Super Admin only — see config/roles.js for
 * why that is a separate key, and auditController for why a deletion always
 * leaves a record of itself behind.
 */
router.delete('/', requirePermission('manage_audit_logs'), clearLogs);
router.delete('/:id', requirePermission('manage_audit_logs'), removeEntry);

module.exports = router;
