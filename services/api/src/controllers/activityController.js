const { Op } = require('sequelize');
const { ActivityLog, Child, Device } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { blindIndex } = require('../utils/crypto');
const { isUuid } = require('../utils/ids');
const { dateRangeWhere } = require('../utils/dateRange');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const resolveChild = (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

const getActivity = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { limit, offset } = parsePagination(req.query, { max: 500, defaultLimit: 50 });
    const { from, to } = req.query;
    const where = { childId: child.id };
    // A date-only `to` covers the whole of that day — see utils/dateRange.js.
    const range = dateRangeWhere(from, to, { Op });
    if (range) where.startTime = range;

    const logs = await ActivityLog.findAndCountAll({
      where,
      include: ['device'],
      order: [['startTime', 'DESC']],
      limit,
      offset,
    });
    res.json(logs);
  } catch (err) {
    next(err);
  }
};

const logActivity = async (req, res, next) => {
  try {
    const { deviceId, childId, appName, appPackage, category, startTime, endTime, durationMinutes, url } = req.body;

    const child = await resolveChild(childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    // A removed device must not keep logging, and must not refresh `lastSeen` —
    // that would show it as recently online after the parent unlinked it.
    const device = isUuid(deviceId)
      ? await Device.findOne({ where: { id: deviceId, childId, isActive: true } })
      : null;
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const log = await ActivityLog.create({ deviceId, childId, appName, appPackage, category, startTime, endTime, durationMinutes, url });

    await device.update({ lastSeen: new Date() });
    res.status(201).json(log);
  } catch (err) {
    next(err);
  }
};

/**
 * How many rows a search may scan.
 *
 * A search cannot run in SQL: `url` is encrypted with a random IV, so matching
 * on part of a domain means decrypting candidates and filtering here. The cap
 * bounds that work, and `truncated` in the response says plainly when a history
 * was long enough to hit it rather than quietly returning a partial answer.
 */
const SEARCH_SCAN_LIMIT = 2000;

// GET /api/activity/:childId/web-history — the parent's browsing history for one
// child. Ownership is checked against the authenticated parent, so a childId
// belonging to another family reads as "not found" rather than leaking rows.
const getWebHistory = async (req, res, next) => {
  try {
    // Guarded before the query: Postgres rejects a malformed UUID outright,
    // which would turn "no such child" into a 500. See utils/ids.js.
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const { from, to, search } = req.query;

    const where = { childId: child.id, category: 'browsing' };
    const range = dateRangeWhere(from, to, { Op });
    if (range) where.startTime = range;

    const term = String(search || '').trim().toLowerCase();
    if (!term) {
      const history = await ActivityLog.findAndCountAll({
        where,
        include: ['device'],
        order: [['startTime', 'DESC']],
        limit,
        offset,
      });
      return res.json({ count: history.count, rows: history.rows, truncated: false });
    }

    // An exact domain can use the blind index and stay a database query; anything
    // shorter has to be matched against decrypted values.
    const exact = await ActivityLog.findAndCountAll({
      where: { ...where, urlHash: blindIndex(term) },
      include: ['device'],
      order: [['startTime', 'DESC']],
      limit,
      offset,
    });
    if (exact.count > 0) return res.json({ count: exact.count, rows: exact.rows, truncated: false });

    const candidates = await ActivityLog.findAll({
      where,
      include: ['device'],
      order: [['startTime', 'DESC']],
      limit: SEARCH_SCAN_LIMIT,
    });
    const matched = candidates.filter((row) => row.url?.toLowerCase().includes(term));

    res.json({
      count: matched.length,
      rows: matched.slice(offset, offset + limit),
      truncated: candidates.length === SEARCH_SCAN_LIMIT,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getActivity, logActivity, getWebHistory };
