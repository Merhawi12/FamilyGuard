const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { getMessages, sendMessage, receiveFromChild } = require('../controllers/chatController');

const childMsgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many messages, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Child device posts a message (no parent session — identified by childId route param)
router.post('/:childId/messages/from-child', childMsgLimiter, receiveFromChild);

// Parent reads and sends messages
router.use(authenticate);
router.get('/:childId/messages', getMessages);
router.post('/:childId/messages', sendMessage);

module.exports = router;
