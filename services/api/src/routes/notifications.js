const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/roleCheck');
const { listMine, markRead, markAllRead, send, listSent } = require('../controllers/notificationController');

router.use(authenticate);

router.get('/', listMine);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', markRead);

router.post('/', requirePermission('send_notifications'), send);
router.get('/sent', requirePermission('send_notifications'), listSent);

module.exports = router;
