const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/roleCheck');
const { listMine, markRead, markAllRead, send, listSent } = require('../controllers/notificationController');
const {
  getPushConfig, subscribe, unsubscribe, listSubscriptions, removeSubscription, sendTest,
} = require('../controllers/pushController');

router.use(authenticate);

// Push subscription management. Declared before '/:id/read' so "push" is never
// taken for a notification id.
router.get('/push/config', getPushConfig);
router.get('/push/subscriptions', listSubscriptions);
router.post('/push/subscribe', subscribe);
router.post('/push/unsubscribe', unsubscribe);
router.post('/push/test', sendTest);
router.delete('/push/subscriptions/:id', removeSubscription);

router.get('/', listMine);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', markRead);

router.post('/', requirePermission('send_notifications'), send);
router.get('/sent', requirePermission('send_notifications'), listSent);

module.exports = router;
