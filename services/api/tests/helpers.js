const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src/app');
const { User, Child, Device } = require('../src/models');
const { RESEND_COOLDOWN_MS } = require('../src/utils/otp');

let counter = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}_${counter++}@test.dev`;

const DEFAULT_PASSWORD = 'password123';

// Creates a verified parent by default. passwordHash is hashed by the model hook.
async function createUser(overrides = {}) {
  return User.create({
    name: 'Test User',
    email: overrides.email || uniqueEmail(),
    passwordHash: DEFAULT_PASSWORD,
    emailVerified: true,
    ...overrides,
  });
}

// Parent session token (no sid → auth middleware skips the Session lookup).
function tokenFor(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createChild(parentId, overrides = {}) {
  return Child.create({ parentId, name: 'Kid', age: 10, ...overrides });
}

async function createDevice(childId, overrides = {}) {
  return Device.create({ childId, name: 'Kid Phone', isLinked: true, isActive: true, ...overrides });
}

/**
 * Waits out the per-account resend cooldown, without waiting.
 *
 * A minute between codes is the real policy and `tests/otp.test.js` is where it
 * is asserted. Everywhere else it is just a suite wanting a second code, so this
 * winds back the one thing an actual wait would change — when the last one went
 * out — leaving the send counter and the window alone so the hourly quota is
 * still counted honestly.
 *
 * Backdates by a whole extra second because the cooldown is compared against
 * `Date.now()` on the next request, which is always slightly later.
 */
async function rewindOtpCooldown(user, purpose = 'email') {
  const fresh = await User.findByPk(user.id);
  const state = fresh.otpState ? JSON.parse(fresh.otpState) : {};
  const entry = state[purpose];
  if (!entry?.lastSentAt) return;
  entry.lastSentAt -= RESEND_COOLDOWN_MS + 1000;
  await fresh.update({ otpState: JSON.stringify(state) });
}

/**
 * Puts a known reset code on an account and hands it back.
 *
 * A suite that only needs to get *through* the reset flow to test something on
 * the far side of it should not have to mock the mailer to read six digits out
 * of an email. Written through the model, so it is stored exactly as
 * `forgot-password` stores it — hashed — and `verify-reset-code` accepts the
 * plaintext this returns. The flow itself is covered end to end in
 * passwordResetFlow.test.js, code included.
 */
async function seedResetCode(user, code = '135790') {
  await user.update({
    passwordResetCode: code,
    passwordResetCodeExpires: new Date(Date.now() + 10 * 60 * 1000),
  });
  return code;
}

const LOGIN_CODE = '246810';

/**
 * A whole password sign-in, second factor and all.
 *
 * `POST /auth/login` no longer answers with a session: every password sign-in is
 * finished with a code emailed to the address, so a suite that only wants *a
 * signed-in parent* would otherwise have to drive two endpoints and mint a code
 * to get one. This drives both and hands back the second response, which carries
 * the same `{ token, user }` the first one used to.
 *
 * The code is written through the model rather than read out of a mailer, the
 * same trade `seedResetCode` makes and for the same reason: it is stored hashed,
 * so the digits exist only in the message, and mocking a mailer to recover them
 * would be a lot of machinery for a step that is not what these suites are about.
 * The real thing — generated, emailed, checked, expired, attempt-limited — is
 * covered end to end in `loginCode.test.js`.
 *
 * Returns the login response untouched when no code was asked for, so it is also
 * correct for the cases that never reach the second step: a wrong password, a
 * locked account, MFA, and a deployment with the factor switched off.
 */
async function signIn(email, password = DEFAULT_PASSWORD, options = {}) {
  const { userAgent = 'Chrome/Test', rememberDevice, trustedDeviceToken } = options;

  const first = await request(app)
    .post('/api/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password, ...(trustedDeviceToken ? { trustedDeviceToken } : {}) });

  if (!first.body?.loginCodeRequired) return first;

  const user = await User.findByEmail(email);
  await user.update({
    loginCode: LOGIN_CODE,
    loginCodeExpires: new Date(Date.now() + 10 * 60 * 1000),
  });

  return request(app)
    .post('/api/auth/login/verify')
    .set('User-Agent', userAgent)
    .send({ preAuthToken: first.body.preAuthToken, code: LOGIN_CODE, rememberDevice });
}

/** Puts a known sign-in code on an account, for suites driving the step by hand. */
async function seedLoginCode(user, code = LOGIN_CODE) {
  await user.update({
    loginCode: code,
    loginCodeExpires: new Date(Date.now() + 10 * 60 * 1000),
  });
  return code;
}

// Device token shaped exactly like the one deviceController issues on link.
function deviceToken(device) {
  return jwt.sign(
    { deviceId: device.id, childId: device.childId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

module.exports = {
  DEFAULT_PASSWORD,
  uniqueEmail,
  createUser,
  tokenFor,
  createChild,
  createDevice,
  deviceToken,
  rewindOtpCooldown,
  seedResetCode,
  signIn,
  seedLoginCode,
  LOGIN_CODE,
};
