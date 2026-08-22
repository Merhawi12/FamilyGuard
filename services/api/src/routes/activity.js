const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const {
  getActivity, logActivity, getWebHistory,
  removeEntry, clearWebHistory, clearActivity,
} = require('../controllers/activityController');

const logLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.get('/:childId/web-history', getWebHistory);
router.get('/:childId', getActivity);
router.post('/', logLimiter, logActivity);

/**
 * Deleting recorded activity.
 *
 * `/entries/:entryId` rather than `/:childId/:entryId` so a single-row delete can
 * never be confused with `/web-history` by route ordering.
 *
 * The two bulk routes both honour `?from`/`?to`, so a clear removes what the
 * screen is showing rather than silently more. Web History and the Activity Log
 * are the same table — see the controller for what that means across the two.
 */
router.delete('/:childId/entries/:entryId', removeEntry);
router.delete('/:childId/web-history', clearWebHistory);
router.delete('/:childId', clearActivity);

module.exports = router;
