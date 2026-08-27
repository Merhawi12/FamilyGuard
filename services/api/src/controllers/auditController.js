const { Op } = require('sequelize');
const { AuditLog, User } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { likeOperator } = require('../utils/queryOperators');
const { dateRangeWhere } = require('../utils/dateRange');
const { LEVELS, levelFor, serviceFor, levelCondition } = require('../utils/logSeverity');
const { auditLog } = require('../utils/auditLogger');

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
/**
 * The action of the entry a deletion leaves behind — see `clearLogs`.
 *
 * Named here rather than inline because three places have to agree about it: the
 * write, and the two reads that refuse to delete it.
 */
const TOMBSTONE = 'audit.entries_deleted';

/**
 * The filters, as a `where`. Shared by the list and the two deletes.
 *
 * Extracted so "clear what I am looking at" cannot drift from "what I am looking
 * at". A second copy of this logic would be correct on the day it was written and
 * wrong the first time either side gained a filter — and the failure mode is not
 * a mismatched count, it is a Clear All that removes rows the operator could not
 * see. `strict` is what makes that safe for the delete path: the list quietly
 * ignores a level it does not recognise, which for a delete would widen the
 * clause to everything.
 */
const streamWhere = ({ action, service, level, q, userId, from, to }, { strict = false } = {}) => {
  const where = {};
  const and = [];

  if (action) and.push({ action: { [Op.like]: `${action}%` } });
  if (service) and.push({ action: { [Op.like]: `${service}.%` } });

  if (level) {
    if (LEVELS.includes(level)) and.push(levelCondition(level));
    else if (strict) return { error: `level must be one of: ${LEVELS.join(', ')}` };
  }

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
  // The console's time windows send full ISO instants and are used as given; a
  // date-only bound covers that whole day — see utils/dateRange.js.
  const range = dateRangeWhere(from, to, { Op });
  if (range) where.createdAt = range;
  if (and.length) where[Op.and] = and;

  return { where };
};

const getLogs = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const { where } = streamWhere(req.query);

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

/**
 * Why deleting from this stream is not simply a `destroy`.
 *
 * The audit trail is the record of what staff did, and `utils/accountErasure.js`
 * goes out of its way to *anonymise* rather than delete it — precisely so that
 * closing an account cannot erase the history of that account's actions. A
 * delete button on the console undoes that guarantee unless the deletion is
 * itself recorded, so both handlers below write a `TOMBSTONE` entry naming the
 * operator, the count and the filters, and neither will delete a tombstone.
 *
 * The result is a trail that can be pruned but not rewritten: entries can go,
 * and the fact that somebody removed them cannot. That is the property worth
 * keeping — an operator clearing noise is ordinary housekeeping, an operator
 * quietly removing the evidence of their own session is not, and nothing else
 * on this screen can tell those two apart afterwards.
 *
 * The tombstone is written *after* the delete, so a request can never catch its
 * own record in the same clause.
 */
const protectTombstones = (where) => ({
  [Op.and]: [where, { action: { [Op.ne]: TOMBSTONE } }],
});

/** DELETE /audit/:id — one entry, from the trash button on its row. */
const removeEntry = async (req, res, next) => {
  try {
    const entry = await AuditLog.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Log entry not found' });

    if (entry.action === TOMBSTONE) {
      return res.status(403).json({
        error: 'A record of a previous deletion cannot itself be deleted.',
      });
    }

    await entry.destroy();

    auditLog(req, {
      userId: req.user.id,
      action: TOMBSTONE,
      entity: 'AuditLog',
      entityId: entry.id,
      // The removed entry is described rather than merely counted: one row gone
      // is exactly the case where which row it was is the whole question.
      metadata: { deleted: 1, scope: 'entry', removedAction: entry.action },
    });

    return res.json({ message: 'Log entry deleted', deleted: 1 });
  } catch (err) {
    return next(err);
  }
};

/**
 * DELETE /audit — everything the current filters describe.
 *
 * Takes the same query parameters the list does, so Clear All removes what is on
 * screen rather than silently all of history — the convention `alertController.
 * clearAlerts` and `activityController.clear` already follow. With no filters it
 * genuinely means everything, which is why the console asks twice for that case.
 */
const clearLogs = async (req, res, next) => {
  try {
    const { where, error } = streamWhere(req.query, { strict: true });
    // An unrecognised level would otherwise drop out of the clause and turn a
    // narrow request into "delete everything" — the worst reading of a bad value.
    if (error) return res.status(400).json({ error });

    const { q, ...rest } = req.query;
    /**
     * The free-text filter reaches the actor through a join, and `destroy` takes
     * no `include` — Sequelize emits `DELETE ... WHERE "$user.name$"`, which is
     * not a column and fails at the database. Rather than delete a wider set
     * than the operator asked for, this refuses.
     */
    if (q) {
      return res.status(400).json({
        error: 'A text search cannot be cleared in bulk. Narrow by level, service or time range instead.',
      });
    }

    const deleted = await AuditLog.destroy({ where: protectTombstones(where) });

    const filters = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined && value !== '')
    );

    auditLog(req, {
      userId: req.user.id,
      action: TOMBSTONE,
      entity: 'AuditLog',
      metadata: {
        deleted,
        scope: Object.keys(filters).length ? 'filtered' : 'all',
        // What the operator had narrowed to, so the tombstone says what went and
        // not merely how much did.
        ...filters,
      },
    });

    return res.json({ message: 'Log entries cleared', deleted });
  } catch (err) {
    return next(err);
  }
};

module.exports = { getLogs, removeEntry, clearLogs, __testing: { TOMBSTONE } };
