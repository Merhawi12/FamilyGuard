/**
 * Canonical form of a phone number for storage and lookup: E.164.
 *
 * The same problem as `normalizeEmail`, only worse, because a number has far
 * more ways of being written than an address does. One person typing
 * `(415) 555-0123`, `415-555-0123` and `+1 415 555 0123` means the same number
 * every time, and a unique index that stores them verbatim would happily accept
 * all three as three different people — each able to receive a code proving they
 * own "their" account.
 *
 * E.164 is `+`, country code, subscriber number, digits only, 15 digits maximum.
 * Everything else — spaces, dashes, brackets, dots — is presentation and is
 * dropped.
 *
 * Two things this deliberately does not do:
 *
 *   - Guess a country. A bare `4155550123` could be American or, with a
 *     different reading, somewhere else entirely; a number without a country
 *     code is rejected rather than assumed into the caller's own. The UI always
 *     supplies one from its country selector, so a missing `+` here means the
 *     request did not come from the UI.
 *   - Validate that the number exists. That needs a subscriber database, and the
 *     verification code already answers the only question that matters: whether
 *     the person asking can receive messages at it.
 */

/** Longest a valid E.164 subscriber number can be, excluding the leading `+`. */
const E164_MAX_DIGITS = 15;
/** Shortest national numbering plans in use run to about seven digits with the country code. */
const E164_MIN_DIGITS = 7;

/**
 * @param {unknown} value
 * @returns {string} the number in E.164, or '' when there is nothing usable
 */
const normalizePhone = (value) => {
  if (typeof value !== 'string') return '';

  const trimmed = value.trim();
  // A leading `00` is how much of the world writes `+` when dialling out.
  const withPlus = trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed;
  if (!withPlus.startsWith('+')) return '';

  const digits = withPlus.slice(1).replace(/\D/g, '');
  if (digits.length < E164_MIN_DIGITS || digits.length > E164_MAX_DIGITS) return '';
  // No country code starts with zero, so a leading zero means a national trunk
  // prefix survived — `+44 07700 900123` rather than `+44 7700 900123`.
  if (digits.startsWith('0')) return '';

  return `+${digits}`;
};

/**
 * A number with most of itself hidden, for showing back to someone who has just
 * been sent a code: `+1 ••• ••• 0123`. Never log or display a whole number that
 * was only ever supplied to receive one message.
 *
 * @param {unknown} value an E.164 number
 * @returns {string}
 */
const maskPhone = (value) => {
  const phone = normalizePhone(value);
  if (!phone) return '';
  return `${phone.slice(0, -4).replace(/\d/g, '•')}${phone.slice(-4)}`;
};

module.exports = { normalizePhone, maskPhone };
