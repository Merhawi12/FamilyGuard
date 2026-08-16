/**
 * `?from=` / `?to=` filters, read the way the person typing them meant them.
 *
 * `<input type="date">` submits `YYYY-MM-DD`, and `new Date('2026-08-12')` is
 * midnight UTC on that date — an *instant*, not a day. Used directly as the
 * upper bound of a `<=` that is exactly the bug this file exists to stop: "From
 * 12 Aug, To 12 Aug" asked for everything at or before midnight, so a parent
 * filtering their child's activity or web history to a single day got an empty
 * table and the honest-looking message "Nothing in that range". The narrower
 * they made the question, the more certainly it answered nothing.
 *
 * A date-only bound therefore covers the whole of that day. A caller that sends
 * a full timestamp — the console's System Logs sends an ISO instant for its
 * "last 15 minutes" window — means that instant and is passed through untouched.
 *
 * Both are interpreted in UTC, which is what `Date` already does with a bare
 * `YYYY-MM-DD` and what the process runs in on Cloud Run. Keeping the two ends
 * on the same clock is what matters: a window whose start is parsed one way and
 * whose end is parsed another can exclude rows that fall between them.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const parse = (value) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Lower bound: a bare date starts at its first millisecond. */
const rangeStart = (value) => parse(value);

/**
 * Upper bound: a bare date ends at its last millisecond, so `<=` includes
 * everything that happened on it.
 */
const rangeEnd = (value) => {
  const date = parse(value);
  if (!date) return null;
  if (!DATE_ONLY.test(String(value).trim())) return date;
  return new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
};

/**
 * Builds the Sequelize operators for a `from`/`to` pair, or `null` when neither
 * was supplied — so a caller can leave the column out of the `where` entirely
 * rather than filtering on an empty object.
 *
 * An unparseable bound is ignored rather than allowed to become an Invalid Date,
 * which Sequelize renders as `NULL` and which silently matches nothing.
 */
const dateRangeWhere = (from, to, { Op }) => {
  const start = from ? rangeStart(from) : null;
  const end = to ? rangeEnd(to) : null;
  if (!start && !end) return null;

  const where = {};
  if (start) where[Op.gte] = start;
  if (end) where[Op.lte] = end;
  return where;
};

module.exports = { rangeStart, rangeEnd, dateRangeWhere };
