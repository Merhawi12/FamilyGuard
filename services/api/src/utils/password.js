const crypto = require('node:crypto');
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

module.exports = { passwordProblem, generatePassword };
