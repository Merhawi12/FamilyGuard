const { fn, col } = require('sequelize');

/**
 * Counting done by the database rather than by fetching the rows and counting
 * them in JavaScript.
 *
 * Three console screens each computed a breakdown the same way: select an entire
 * table with one column projected, then `filter().length` per bucket. That is a
 * full table scan and a full row materialisation per page view, and it grows
 * with the customer base while the number it produces stays a handful of
 * integers — the fleet summary pulled every active device to report four
 * platform totals, the billing summary pulled every customer to report the plan
 * mix, and content filtering pulled every website rule to report five.
 *
 * These are deliberately narrow. `COUNT` over a `GROUP BY` is spelled the same
 * on SQLite and Postgres, which is what makes them safe to share; date
 * truncation and string aggregation are not, and the callers that need those
 * still bucket in JS on purpose. Do not widen this file to cover them without
 * checking both dialects.
 */

/**
 * The database column behind a model attribute.
 *
 * `col()` is passed through to SQL verbatim, so it needs the real column name.
 * Every model in this codebase is `underscored: true`, which means `childId` is
 * stored as `child_id` and `col('childId')` would reference a column that does
 * not exist — on Postgres that is an error, and it is the kind that only shows
 * up in production because SQLite is more forgiving about quoting. Sequelize
 * already knows the mapping, so this asks it rather than re-deriving it.
 */
const columnOf = (model, attribute) => model.getAttributes()[attribute]?.field || attribute;

/**
 * `SELECT <attribute>, COUNT(<pk>) FROM <model> [WHERE …] GROUP BY <attribute>`,
 * as a `Map` from value to count.
 *
 * `Number()` because the two dialects disagree about whether a count comes back
 * as a number or a decimal string.
 *
 * @param {import('sequelize').ModelStatic<any>} model
 * @param {string} attribute a model attribute, not a column name.
 * @param {object} [where]
 * @returns {Promise<Map<any, number>>}
 */
const countGrouped = async (model, attribute, where) => {
  const rows = await model.findAll({
    attributes: [attribute, [fn('COUNT', col(columnOf(model, model.primaryKeyAttribute))), 'count']],
    ...(where ? { where } : {}),
    group: [attribute],
    raw: true,
  });
  return new Map(rows.map((row) => [row[attribute], Number(row.count) || 0]));
};

/**
 * The same shape as `countGrouped`, but counting *distinct* values of a second
 * attribute — "how many separate children have a rule in this category", not
 * "how many rules are in it".
 */
const countDistinctGrouped = async (model, attribute, distinctAttribute, where) => {
  const rows = await model.findAll({
    attributes: [
      attribute,
      [fn('COUNT', fn('DISTINCT', col(columnOf(model, distinctAttribute)))), 'count'],
    ],
    ...(where ? { where } : {}),
    group: [attribute],
    raw: true,
  });
  return new Map(rows.map((row) => [row[attribute], Number(row.count) || 0]));
};

/** `COUNT(DISTINCT <attribute>)` over the whole (optionally filtered) table. */
const countDistinct = async (model, attribute, where) => {
  const row = await model.findOne({
    attributes: [[fn('COUNT', fn('DISTINCT', col(columnOf(model, attribute)))), 'count']],
    ...(where ? { where } : {}),
    raw: true,
  });
  return Number(row?.count) || 0;
};

module.exports = { countGrouped, countDistinctGrouped, countDistinct, columnOf };
