/**
 * Safe `limit`/`offset` from untrusted query strings.
 *
 * Query values are always strings and may be absent, junk, negative or absurd.
 * Passing `parseInt('abc')` straight to Sequelize puts `NaN` into the SQL and
 * turns a typo in a URL into a 500, so every list endpoint funnels through here
 * instead of repeating the same three-line dance.
 *
 * @param {object} query           the Express `req.query`
 * @param {object} [opts]
 * @param {number} [opts.max]      largest page this endpoint will serve
 * @param {number} [opts.defaultLimit]
 * @returns {{ limit: number, offset: number }}
 */
const parsePagination = (query = {}, { max = 100, defaultLimit = 50 } = {}) => {
  const asInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const limit = Math.min(Math.max(asInt(query.limit, defaultLimit), 1), max);
  const offset = Math.max(asInt(query.offset, 0), 0);

  return { limit, offset };
};

module.exports = { parsePagination };
