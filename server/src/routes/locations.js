const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const { postLocation, getCurrentLocation, getHistory } = require('../controllers/locationController');

// Mobile app posts location — rate-limited, no auth (identified by childId+deviceId)
const locationPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // max 1 update/second per IP
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/', locationPostLimiter, postLocation);

// Parent dashboard reads location — requires auth
router.get('/:childId/current', authenticate, requireFeature('gps_tracking'), getCurrentLocation);
router.get('/:childId/history', authenticate, requireFeature('gps_tracking'), getHistory);

module.exports = router;
