const { Op } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * The case-insensitive "contains" operator for the dialect actually in use.
 *
 * Postgres has `ILIKE` and its `LIKE` is case-sensitive; SQLite has no `ILIKE`
 * but its `LIKE` already ignores ASCII case. Picking per dialect is what keeps a
 * search behaving the same in the SQLite test suite and on Cloud SQL.
 */
const likeOperator = () => (sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like);

module.exports = { likeOperator };
