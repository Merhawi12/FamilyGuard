const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getAlerts, markRead, markAllRead, removeAlert, clearAlerts,
} = require('../controllers/alertController');

router.use(authenticate);
router.get('/', getAlerts);
router.put('/read-all', markAllRead);
router.put('/:id/read', markRead);
// `DELETE /` takes the same `unreadOnly`/`severity` filters the list does, so a
// clear removes what the screen is showing rather than silently more.
router.delete('/', clearAlerts);
router.delete('/:id', removeAlert);

module.exports = router;
