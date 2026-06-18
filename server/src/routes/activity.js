const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { getActivity, logActivity } = require('../controllers/activityController');

const logLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.get('/:childId', getActivity);
router.post('/', logLimiter, logActivity);

module.exports = router;
