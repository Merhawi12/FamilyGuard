const { Op } = require('sequelize');
const { AuditLog, User } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { likeOperator } = require('../utils/queryOperators');
const { LEVELS, levelFor, serviceFor, levelCondition } = require('../utils/logSeverity');

/**
 * GET /audit — the platform's log stream, filtered.
 *
 * Every filter narrows the query rather than the page: the console shows a row
 * count and a paginator beside these results, and a filter applied in the
 * browser would leave both describing a set the operator cannot see.
 *
 *   q        free text over the action, the entity, the address and the actor
 *   level    critical | error | warning | info, derived from the action name
 *   service  the part of the action before the dot — auth, admin, device…
 *   action   prefix match, kept because it is what the endpoint has always taken
 *   from/to  the time range
 *
 * The conditions collect in one `Op.and` array because most of them constrain
 * the same column: two `action` keys in a single object would silently leave
 * only the last one standing.
 */
const getLogs = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const { action, service, level, q, userId, from, to } = req.query;

    const where = {};
    const and = [];

    if (action) and.push({ action: { [Op.like]: `${action}%` } });
    if (service) and.push({ action: { [Op.like]: `${service}.%` } });
    if (level && LEVELS.includes(level)) and.push(levelCondition(level));

    if (q) {
      // Case-insensitive for the dialect in use — SQLite's LIKE ignores ASCII
      // case and Postgres' does not, so a plain Op.like passes the test suite
      // and then fails to find "Wilhelmina" for someone who typed "wilhelmina".
      const contains = { [likeOperator()]: `%${q}%` };
      and.push({
        [Op.or]: [
          { action: contains },
          { entity: contains },
          { ipAddress: contains },
          // Reaches the actor through the join below. `entityId` is deliberately
          // not searched: it is a uuid column, and Postgres has no LIKE for one.
          { '$user.name$': contains },
          { '$user.email$': contains },
        ],
      });
    }

    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to) where.createdAt[Op.lte] = new Date(to);
    }
    if (and.length) where[Op.and] = and;

    const logs = await AuditLog.findAndCountAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      // The actor's name and email are searchable, and a `$user.name$` condition
      // cannot be applied inside the limiting sub-query the default would build.
      // Safe for the count as well: the include is a belongsTo, so the join
      // cannot multiply a row.
      subQuery: false,
    });

    res.json({
      count: logs.count,
      // `rows` keeps its shape and gains the two fields the console shows for
      // every entry, so anything already reading this endpoint is untouched.
      rows: logs.rows.map((row) => {
        const log = row.toJSON();
        return { ...log, level: levelFor(log.action), service: serviceFor(log.action) };
      }),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getLogs };
