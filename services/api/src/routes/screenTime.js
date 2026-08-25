const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getRule, updateRule, clearDeviceRule, listGrants, grantExtraTime,
} = require('../controllers/screenTimeController');

router.use(authenticate);

/**
 * Every route here takes an optional `?deviceId=`. Without it they read and write
 * the child's rule, which is every caller that existed before per-device control
 * and is still what the Screen Time page sends by default.
 *
 * `/grant` is the one that is not a rule: extra minutes for today, which expire
 * on their own and leave the rule saying what the parent decided in general. It
 * sits under this path rather than its own because it is the other half of the
 * limit — see models/ScreenTimeGrant.js.
 */
router.get('/:childId', getRule);
router.put('/:childId', updateRule);
// Removes one device's exception so it follows the child's rule again.
router.delete('/:childId', clearDeviceRule);

router.get('/:childId/grant', listGrants);
router.post('/:childId/grant', grantExtraTime);

module.exports = router;
