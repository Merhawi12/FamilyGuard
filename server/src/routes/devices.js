const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate, authenticateDevice } = require('../middleware/auth');
const {
  getDevices, generateLink, confirmLink, removeDevice,
  getDeviceRules, deviceHeartbeat, deviceLogActivity,
} = require('../controllers/deviceController');

const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many linking attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Device-authenticated routes (child app uses these)
router.get('/me/rules', authenticateDevice, getDeviceRules);
router.post('/me/heartbeat', authenticateDevice, deviceHeartbeat);
router.post('/me/activity', authenticateDevice, deviceLogActivity);

// Standard routes
router.post('/confirm', confirmLimiter, confirmLink);
router.get('/', authenticate, getDevices);
router.post('/link', authenticate, generateLink);
router.delete('/:id', authenticate, removeDevice);

module.exports = router;
