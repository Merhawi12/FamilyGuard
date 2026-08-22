const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');

/**
 * Checks a candidate password against the policy.
 *
 * @returns {string|null} the reason it was rejected, or null if acceptable.
 */
const passwordProblem = (password) => {
  if (!password || password.length < env.auth.minPasswordLength) {
    return `Password must be at least ${env.auth.minPasswordLength} characters`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
};

/** Satisfies the password policy (length + letter + digit) by construction. */
const generatePassword = () =>
  `Px${crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '')}${crypto.randomInt(10, 100)}`;

/**
 * A bcrypt comparison that costs what a real one costs and is always wrong.
 *
 * Sign-in answers an unknown address and a wrong password with the same 401, and
 * that is undone by the clock if only one of them hashes: a cost-12 comparison
 * is ~200ms and a short-circuited one is ~0, which is a difference anyone can
 * measure from the other side of the internet. Running this in the branches that
 * have nothing to compare against — no such account, or an account created
 * through Google or a phone number and holding no hash — puts the two paths back
 * on the same footing.
 *
 * The hash is a constant rather than generated at boot for the obvious reason:
 * generating one would spend that same 200ms on every cold start. Its plaintext
 * was 32 random bytes and was never recorded, so nothing can match it. The
 * comparison's result is discarded and `false` returned literally, so this can
 * never become a way in even if the constant were somehow chosen badly.
 */
const DECOY_HASH = '$2a$12$VFPngOYyCa5g2AVSiBLh4OLIp3EnRpD0ay7rfMhme3hNw4fo5SYVS';

const burnPasswordComparison = async (candidate) => {
  try {
    await bcrypt.compare(String(candidate ?? ''), DECOY_HASH);
  } catch {
    /* the work is the point; its outcome is not */
  }
  return false;
};

module.exports = { passwordProblem, generatePassword, burnPasswordComparison };
