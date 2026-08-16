const jwt = require('jsonwebtoken');
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
};
