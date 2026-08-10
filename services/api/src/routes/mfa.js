const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { setup, enable, disable, validate } = require('../controllers/mfaController');

/**
 * The second factor is a six-digit number, and this route was the only
 * credential check in the API with no limiter of its own — the global 300/min
 * backstop was the whole of it, which is thousands of guesses against a live
 * code. Matched to `codeLimiter` in routes/auth.js, which caps the emailed and
 * texted codes for exactly the same reason.
 *
 * The account-wide lockout in `mfaController.validate` is the other half: this
 * caps one address, that caps the account however many addresses are used.
 */
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, please sign in again' },
  standardHeaders: true,
  legacyHeaders: false,
});

// validate is the second login step — no session JWT yet, uses preAuthToken instead
router.post('/validate', mfaLimiter, validate);

// All other MFA actions require a valid session
router.use(authenticate);
router.post('/setup', setup);
router.post('/enable', enable);
router.post('/disable', disable);

module.exports = router;
