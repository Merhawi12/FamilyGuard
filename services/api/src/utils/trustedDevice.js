const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { JWT_VERIFY_OPTIONS } = require('./jwtOptions');

/**
 * "Don't ask me for a code on this browser again."
 *
 * A signed claim held by the client, not a row. The alternative — a table of
 * device fingerprints — buys per-device revocation and costs a lookup on the
 * hottest path in the product plus a fingerprint that is wrong the moment
 * somebody updates their browser. What it would actually be used for is "sign me
 * out of everything", and `trustedDevicesRevokedAt` gives that for one column and
 * no lookup at all.
 *
 * ## Why this exists rather than a code every single time
 *
 * `utils/otp.js` allows five sends an hour per account. A parent with a phone and
 * a laptop, or one who signs out and back in, reaches that ceiling in ordinary
 * use — and the failure is being locked out of the product by the security
 * feature meant to protect it, with a message about rate limits. Remembering the
 * browser is what keeps the code an event rather than a toll.
 *
 * ## What it is worth to an attacker
 *
 * Everything a second factor is meant to stop, for thirty days — which is the
 * honest cost of every "remember this device" ever shipped. It is mitigated by
 * being bound to one account, useless without the password, and revoked wholesale
 * whenever the password changes, which is the moment the account holder is
 * telling us they think it is compromised.
 *
 * It carries no `sid` and no `mfaRequired`, so it authenticates nothing: the
 * middleware needs a session for anything real, and this token names none.
 */

const TRUSTED_DEVICE_DAYS = 30;
const PURPOSE = 'trusted-device';

const signTrustedDeviceToken = (userId) =>
  jwt.sign({ id: userId, purpose: PURPOSE }, env.auth.jwtSecret, {
    expiresIn: `${TRUSTED_DEVICE_DAYS}d`,
  });

/**
 * Whether this browser may skip the emailed code for this account.
 *
 * Four things have to hold, and the last is the one that is easy to leave out:
 * the token must be valid, purpose-scoped, *for this user*, and issued after the
 * account's last revocation. Without the third check any account's token would
 * skip any other account's second factor; without the fourth, changing a password
 * would revoke every session and leave the thing that bypasses the second factor
 * untouched.
 *
 * `iat` is in seconds and `trustedDevicesRevokedAt` is a millisecond timestamp,
 * so the comparison is done in milliseconds. A token minted in the same second as
 * the revocation is refused rather than allowed — the safer rounding, and the one
 * that matters when both happen inside a single request.
 */
const trustsDevice = (token, user) => {
  if (!token || !user) return false;

  let decoded;
  try {
    decoded = jwt.verify(token, env.auth.jwtSecret, JWT_VERIFY_OPTIONS);
  } catch {
    return false;
  }

  if (decoded.purpose !== PURPOSE) return false;
  if (decoded.id !== user.id) return false;

  if (user.trustedDevicesRevokedAt) {
    const issuedAt = (decoded.iat || 0) * 1000;
    if (issuedAt <= new Date(user.trustedDevicesRevokedAt).getTime()) return false;
  }

  return true;
};

/** Everything currently remembered stops being remembered. */
const revokeTrustedDevices = (user, { transaction } = {}) =>
  user.update({ trustedDevicesRevokedAt: new Date() }, { transaction });

module.exports = {
  signTrustedDeviceToken,
  trustsDevice,
  revokeTrustedDevices,
  TRUSTED_DEVICE_DAYS,
};
