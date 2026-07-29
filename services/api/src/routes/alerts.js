const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getAlerts, markRead, markAllRead } = require('../controllers/alertController');

router.use(authenticate);
router.get('/', getAlerts);
router.put('/read-all', markAllRead);
router.put('/:id/read', markRead);

module.exports = router;
