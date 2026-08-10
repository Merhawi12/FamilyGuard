const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate, authenticateDevice } = require('../middleware/auth');
const {
  getDevices, generateLink, regenerateLink, confirmLink, updateDevice, removeDevice,
  getDeviceRules, getDeviceContacts, deviceHeartbeat, deviceLogActivity, deviceLogWebHistory,
} = require('../controllers/deviceController');
const { registerDeviceToken, removeDeviceToken } = require('../controllers/pushController');

/**
 * Meters *failed* guesses, which is the only thing here worth metering.
 *
 * This counted every request, so a link that worked spent the same budget as a
 * wrong code. A household setting up three children's phones in one sitting
 * burned three attempts before anyone made a mistake, and the family Wi-Fi is a
 * single IP — so did a parent retrying beside them. `skipSuccessfulRequests`
 * makes the ceiling mean "ten things went wrong" rather than "ten things
 * happened", which is what the message already claims it means.
 *
 * The ceiling can afford to be about usability rather than entropy: a linking
 * code is eight uppercase hex characters (`randomBytes(4)`) — 4.3 billion
 * possibilities — single-use, and dead after 30 minutes. Ten guesses per quarter
 * hour was never what stood between an attacker and a device; the code's own
 * size is. What the limit really does is stop a loop hammering the endpoint, and
 * it still does that.
 *
 * Note for anyone tuning this: mobile carriers put many subscribers behind one
 * public address (CGNAT), so this bucket is not always one household. That is
 * the argument against tightening it further.
 */
const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many linking attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Re-issuing a code gets its own bucket. Sharing the confirm one would let a
// parent retrying from the family Wi-Fi use up the attempts the child's phone
// needs to complete the link from that same address.
const reissueLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many code requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Device-authenticated routes (child app uses these)
router.get('/me/rules', authenticateDevice, getDeviceRules);
router.get('/me/contacts', authenticateDevice, getDeviceContacts);
router.post('/me/heartbeat', authenticateDevice, deviceHeartbeat);
router.post('/me/activity', authenticateDevice, deviceLogActivity);
router.post('/me/web-history', authenticateDevice, deviceLogWebHistory);
router.post('/me/push-token', authenticateDevice, registerDeviceToken);
router.delete('/me/push-token', authenticateDevice, removeDeviceToken);

// Standard routes
router.post('/confirm', confirmLimiter, confirmLink);
router.get('/', authenticate, getDevices);
router.post('/link', authenticate, generateLink);
router.patch('/:id', authenticate, updateDevice);
// Re-issues a linking code for a device that never connected.
router.post('/:id/link', reissueLimiter, authenticate, regenerateLink);
router.delete('/:id', authenticate, removeDevice);

module.exports = router;
