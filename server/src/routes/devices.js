const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { getDevices, generateLink, confirmLink, removeDevice } = require('../controllers/deviceController');

const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many linking attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/confirm', confirmLimiter, confirmLink);
router.get('/', authenticate, getDevices);
router.post('/link', authenticate, generateLink);
router.delete('/:id', authenticate, removeDevice);

module.exports = router;
