/**
 * Canonical form of an email address for storage and lookup.
 *
 * Addresses are case-insensitive in practice but Postgres compares them
 * case-sensitively, so every write and every lookup has to agree on one form or
 * accounts silently fork. Only case and surrounding whitespace are touched —
 * provider-specific tricks (dots, `+tags`) are left alone, because two people
 * may legitimately hold `a.b@` and `ab@` outside Gmail.
 *
 * @param {unknown} value
 * @returns {string} the normalized address, or '' when there is nothing usable
 */
const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

module.exports = { normalizeEmail };
