const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getRule, updateRule, clearDeviceRule } = require('../controllers/screenTimeController');

router.use(authenticate);

/**
 * All three take an optional `?deviceId=`. Without it they read and write the
 * child's rule, which is every caller that existed before per-device control and
 * is still what the Screen Time page sends by default.
 */
router.get('/:childId', getRule);
router.put('/:childId', updateRule);
// Removes one device's exception so it follows the child's rule again.
router.delete('/:childId', clearDeviceRule);

module.exports = router;
