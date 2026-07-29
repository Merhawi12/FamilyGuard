const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { createChildAvatarUpload } = require('../controllers/uploadController');

// Pre-signed URLs are cheap to mint but grant write access — cap how many a
// single account can request.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many upload requests, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.post('/child-avatar', uploadLimiter, createChildAvatarUpload);

module.exports = router;
