const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const {
  register, login, verifyLoginCode, resendLoginCode, me, logout, verifyEmail, resendCode,
  updateProfile, changePassword,
  googleAuth, authProviders, requestPhoneCode, verifyPhoneCode,
  forgotPassword, verifyResetCode, resetPassword,
  getNotificationPrefs, updateNotificationPrefs,
  listSessions, revokeOneSession, revokeOtherSessionsForUser, deleteAccount,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { env } = require('../config/env');

/**
 * The SMS code limiter is the one limit that is genuinely unworkable locally.
 *
 * Three requests an hour is right in production, where each one spends money at
 * the provider and lands on a real handset — but it is also three attempts at
 * the whole phone sign-in flow per hour for whoever is building it, after which
 * the only remedy is to wait or restart the process. Development gets a ceiling
 * that still stops a runaway loop without stopping the work.
 *
 * Deliberately keyed off `isDevelopment`, which is false under NODE_ENV=test, so
 * tests/authRateLimit.test.js keeps checking the production numbers.
 */
const devLimit = (production, development) => (env.isDevelopment ? development : production);

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

// Every call to this one sends a billed SMS, so it is capped tighter than the
// email flows and counted over a longer window. Three is enough for a mistyped
// number and a genuine resend; a fourth in an hour is not a person signing in.
const phoneCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: devLimit(3, 100),
  message: { error: 'Too many code requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The verification code is only six digits, so the window it is valid for has to
// be closed by attempt count as well as by time — the global 300/min backstop
// would otherwise allow thousands of guesses against a live code.
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, please request a new code' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The sign-in code gets its own counters rather than sharing the ones above.
 *
 * A `rateLimit()` instance owns a store, so every route given the *same*
 * instance shares one budget per IP. That is right for the flows that already
 * share `codeLimiter` — confirming an address and resetting a password are both
 * once-in-a-while events — and wrong the moment a routine sign-in is added to
 * them: ten code checks per IP per quarter hour, spent by signups, resets and
 * *every password sign-in on that address*, is a ceiling a single household
 * behind one router reaches on an ordinary evening. Handed the shared limiter,
 * this is what the browser suite found — the console's sign-in was refused 429
 * because the sign-ins before it had spent the budget.
 *
 * Sized for the step rather than copied: `loginLimiter` already caps reaching
 * this at ten challenges per IP per fifteen minutes, and each challenge allows
 * five guesses before `utils/otp` destroys the code, so thirty leaves room for
 * a mistyped code and a second person in the house without ever being the thing
 * that bounds guessing. The account lockout and the per-code budget do that.
 */
const loginCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts, please request a new code' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Same reasoning, for the same reason: asking for another sign-in code must not
// spend the budget that gets a new account its verification email. The number
// matches `resendLimiter` — this is the same act, counted separately.
const loginResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many resend attempts, please wait 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/register', registerLimiter, register);
router.post('/verify-email', codeLimiter, verifyEmail);
router.post('/resend-code', resendLimiter, resendCode);
router.post('/login', loginLimiter, login);

/**
 * The emailed second factor, in the two calls that finish it.
 *
 * Both carry a per-IP ceiling on top of the per-account lockout the controller
 * applies — these are six digits standing between a correct password and a
 * session. Both ceilings are their own, for the reason given where they are
 * defined: sharing them with the signup and reset flows makes an ordinary
 * evening's sign-ins look like an attack.
 */
router.post('/login/verify', loginCodeLimiter, verifyLoginCode);
router.post('/login/resend', loginResendLimiter, resendLoginCode);

/**
 * Phone sign-in. Requesting a code is rate limited harder than any other route
 * here, because unlike the email equivalent every call spends real money at the
 * SMS provider — an unthrottled endpoint that sends a paid message per request
 * is a billing incident waiting to happen, quite apart from what it does to the
 * number on the receiving end. Verifying reuses `codeLimiter`: six digits need
 * their window closed by attempt count as well as by time.
 */
router.post('/phone/request', phoneCodeLimiter, requestPhoneCode);
router.post('/phone/verify', codeLimiter, verifyPhoneCode);
// Limited like a login, because that is what it is: the ID token is the
// credential, and an unlimited endpoint is a free oracle for probing which
// addresses have accounts.
router.post('/google', loginLimiter, googleAuth);
// Read-only and unauthenticated on purpose — the sign-in page has to know
// whether to draw the Google button before anyone has signed in.
router.get('/providers', authProviders);
/**
 * Forgotten password, in three steps: ask for a code, present it, choose a new
 * password.
 *
 * `verify-reset-code` gets `codeLimiter` for the same reason the other two code
 * screens do — six digits need their window closed by attempt count as well as
 * by time — and `reset-password` keeps it because the ticket it takes is the
 * last thing standing between a caller and somebody's account.
 */
router.post('/forgot-password', resendLimiter, forgotPassword);
router.post('/verify-reset-code', codeLimiter, verifyResetCode);
router.post('/reset-password', codeLimiter, resetPassword);
router.get('/me', authenticate, me);
router.post('/logout', authenticate, logout);
router.put('/profile', authenticate, updateProfile);
router.put('/password', authenticate, changePassword);
router.get('/sessions', authenticate, listSessions);
router.delete('/sessions/others', authenticate, revokeOtherSessionsForUser);
router.delete('/sessions/:id', authenticate, revokeOneSession);
/**
 * Rate limited like a sign-in attempt. It re-checks the password, so it is one
 * more place a stolen session could be used to guess it — and it is the only
 * endpoint on the service whose success cannot be undone.
 */
router.delete('/account', loginLimiter, authenticate, deleteAccount);
router.get('/notification-prefs', authenticate, getNotificationPrefs);
router.put('/notification-prefs', authenticate, updateNotificationPrefs);

module.exports = router;
