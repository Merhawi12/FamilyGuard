const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { getLogs } = require('../controllers/auditController');

router.use(authenticate, requireRole('admin'));
router.get('/', getLogs);

module.exports = router;
