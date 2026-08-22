const { Op } = require('sequelize');
const { ActivityLog, Child, Device } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { blindIndex } = require('../utils/crypto');
const { isUuid } = require('../utils/ids');
const { dateRangeWhere } = require('../utils/dateRange');
const { auditLog } = require('../utils/auditLogger');

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

/**
 * Deleting activity, and the one thing to understand before reading the three
 * handlers below.
 *
 * **Web History and the Activity Log are the same table.** A browsing row is an
 * `ActivityLog` row with `category: 'browsing'`; the Activity Log screen shows
 * every category, so it shows those rows too — which is why a single screenshot
 * of it lists both "Microsoft Edge, 3m" and "app-measurement.com, 0m".
 *
 * That means deletions cross between the two screens, and a parent has to be
 * told so rather than discovering it:
 *
 * - Deleting one row removes it from **both** screens. There is only one row.
 * - Clearing Web History removes the browsing rows from the Activity Log too.
 * - Clearing the Activity Log takes the browsing rows with it, so it clears the
 *   Web History as well.
 *
 * The confirmation copy in the Family App says each of these in words. Hiding it
 * would produce the worst version of this feature: a parent clears the activity
 * log, finds their child's browsing history gone, and cannot tell whether they
 * deleted it or the device stopped reporting.
 *
 * Every handler here is audited. Monitoring records that can be destroyed
 * without trace are a different product from ones that cannot — the audit entry
 * is what distinguishes "deleted" from "never recorded" for anyone else on the
 * account.
 */

/**
 * DELETE /api/activity/:childId/entries/:entryId — one row, from either screen.
 *
 * `entries/` rather than `:childId/:entryId`, so the path can never collide with
 * `:childId/web-history`. Express would resolve that by declaration order, which
 * works right up until someone reorders the file.
 */
const removeEntry = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    // Matched on the child as well as the id: an entry id belonging to another
    // family reads as "not found" rather than being deleted.
    const entry = isUuid(req.params.entryId)
      ? await ActivityLog.findOne({ where: { id: req.params.entryId, childId: child.id } })
      : null;
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const { category, appName } = entry;
    await entry.destroy();
    auditLog(req, {
      userId: req.user.id,
      action: 'activity.entry_deleted',
      entity: 'ActivityLog',
      entityId: req.params.entryId,
      // Never the url: it is encrypted on the row precisely so it does not sit
      // in plain text elsewhere, and an audit log is elsewhere.
      metadata: { childId: child.id, category, appName: appName || null },
    });
    return res.json({ message: 'Entry deleted', deleted: 1 });
  } catch (err) {
    return next(err);
  }
};

/**
 * The rows a bulk clear will actually remove.
 *
 * Bulk deletes honour the screen's active date range for the same reason the
 * alert clear honours its filter: a parent looking at one week and pressing
 * "Clear" is asking about the week in front of them, and a delete that silently
 * widened to all of history is not something a dialog can warn about, because
 * what it would destroy is not on screen.
 *
 * Both callers report the count back so the UI states what happened rather than
 * assuming its own page of 50 was the whole of it.
 */
const clearRange = async (req, childId, extra = {}) => {
  const where = { childId, ...extra };
  const range = dateRangeWhere(req.query.from, req.query.to, { Op });
  if (range) where.startTime = range;
  return { where, deleted: await ActivityLog.destroy({ where }) };
};

/**
 * DELETE /api/activity/:childId/web-history — clear browsing rows.
 *
 * Scoped to `category: 'browsing'`, so app usage on the Activity Log survives.
 * The reverse is not true; see the note above `removeEntry`.
 *
 * `search` is deliberately **not** honoured here, unlike `from`/`to`. Searching
 * decrypts and filters in application code over a capped scan (see
 * `SEARCH_SCAN_LIMIT`), so a search-scoped delete could only ever remove the
 * rows that scan happened to reach — silently leaving matches behind while
 * reporting success. The Family App hides the clear button while a search is
 * active rather than offering a delete that is quietly partial.
 */
const clearWebHistory = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { deleted } = await clearRange(req, child.id, { category: 'browsing' });
    auditLog(req, {
      userId: req.user.id,
      action: 'activity.web_history_cleared',
      entity: 'ActivityLog',
      metadata: {
        childId: child.id, deleted, from: req.query.from || null, to: req.query.to || null,
      },
    });
    return res.json({ message: 'Web history cleared', deleted });
  } catch (err) {
    return next(err);
  }
};

/**
 * DELETE /api/activity/:childId — clear the activity log.
 *
 * Every category, browsing included, because that is what the screen shows.
 */
const clearActivity = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { deleted } = await clearRange(req, child.id);
    auditLog(req, {
      userId: req.user.id,
      action: 'activity.cleared',
      entity: 'ActivityLog',
      metadata: {
        childId: child.id, deleted, from: req.query.from || null, to: req.query.to || null,
      },
    });
    return res.json({ message: 'Activity log cleared', deleted });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getActivity, logActivity, getWebHistory,
  removeEntry, clearWebHistory, clearActivity,
};
