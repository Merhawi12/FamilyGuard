const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { register, login, me, logout, verifyEmail, resendCode, updateProfile, changePassword, forgotPassword, resetPassword, getNotificationPrefs, updateNotificationPrefs } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many resend attempts, please wait 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/register', registerLimiter, register);
router.post('/verify-email', verifyEmail);
router.post('/resend-code', resendLimiter, resendCode);
router.post('/login', loginLimiter, login);
router.post('/forgot-password', resendLimiter, forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/me', authenticate, me);
router.post('/logout', authenticate, logout);
router.put('/profile', authenticate, updateProfile);
router.put('/password', authenticate, changePassword);
router.get('/notification-prefs', authenticate, getNotificationPrefs);
router.put('/notification-prefs', authenticate, updateNotificationPrefs);

module.exports = router;
