const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate, authenticateDevice } = require('../middleware/auth');
const { getMessages, sendMessage, receiveFromChild, getMyMessages } = require('../controllers/chatController');

const childMsgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many messages, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Child device posts a message — authenticated with the device token.
// The child is derived from the token, not the route param.
router.post('/:childId/messages/from-child', childMsgLimiter, authenticateDevice, receiveFromChild);

// Child device reads its own thread. Registered before the parent guard below,
// and matched ahead of `/:childId/messages` because `me` is a literal segment.
router.get('/me/messages', authenticateDevice, getMyMessages);

// Parent reads and sends messages
router.use(authenticate);
router.get('/:childId/messages', getMessages);
router.post('/:childId/messages', sendMessage);

module.exports = router;
