const { Op } = require('sequelize');
const { ActivityLog, Child } = require('../models');

const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const resolveChild = (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

const getDailySummary = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const { date } = req.query;
  const target = date ? new Date(date) : new Date();
  /**
   * An unparseable `?date=` is the caller's mistake, not a server fault.
   *
   * `new Date('yesterday')` is an Invalid Date, which flows into the `Op.between`
   * bounds and then into `target.toISOString()` at the bottom of this handler —
   * where it throws a RangeError and turns a mistyped query string into a 500.
   */
  if (Number.isNaN(target.getTime())) {
    return res.status(400).json({ error: 'date must be a valid date, for example 2026-08-09' });
  }
  /**
   * The day is bounded in UTC, which is the clock every other report is keyed
   * on: `getWeeklySummary` buckets by `startTime.toISOString()`, and the device
   * files a usage day under the UTC instant of its own local midnight.
   *
   * `setHours` is the server's *local* clock. On Cloud Run that is UTC and the
   * two agree, but on any other machine they do not — a developer asking for
   * 12 August got the window their own timezone puts around midnight UTC, which
   * is a different day's rows from the one the weekly chart shows under the
   * same label. Two reports of one day disagreeing is worse than either being
   * wrong, so both are stated on the same clock.
   */
  const start = new Date(Date.UTC(
    target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(),
  ));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  const logs = await ActivityLog.findAll({
    where: { childId: child.id, startTime: { [Op.between]: [start, end] } },
  });

  const totalMinutes = logs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
  const byApp = logs.reduce((acc, l) => {
    acc[l.appName] = (acc[l.appName] || 0) + (l.durationMinutes || 0);
    return acc;
  }, {});
  const byCategory = logs.reduce((acc, l) => {
    acc[l.category] = (acc[l.category] || 0) + (l.durationMinutes || 0);
    return acc;
  }, {});

  res.json({ date: target.toISOString().split('T')[0], totalMinutes, byApp, byCategory, sessionCount: logs.length });
};

/** The seven-day window every weekly report is measured over. */
const weekWindow = () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return { start, end };
};

/**
 * Minutes per calendar day, keyed the way every weekly report has always keyed
 * them.
 *
 * The bucket is the UTC date of the sample's `startTime`, which is not an
 * accident: the device files a usage sample under the instant of its own local
 * midnight, so for a family in Canada that instant lands on the same UTC date.
 * The clients look these up with `localDateKey` for the same reason — see
 * packages/shared/src/dates.js.
 */
const bucketByDay = (logs) => {
  const days = {};
  logs.forEach((l) => {
    const at = new Date(l.startTime);
    // A row whose timestamp will not parse belongs in no bucket, and must not
    // cost the whole dashboard a 500.
    if (Number.isNaN(at.getTime())) return;
    const day = at.toISOString().split('T')[0];
    days[day] = (days[day] || 0) + (l.durationMinutes || 0);
  });
  return days;
};

const getWeeklySummary = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const { start, end } = weekWindow();

  const logs = await ActivityLog.findAll({
    where: { childId: child.id, startTime: { [Op.between]: [start, end] } },
    // Three columns rather than the whole row: this used to select every stored
    // field of every session in the week — device ids, categories, urls, the
    // timestamps Sequelize adds — to add up two of them.
    attributes: ['startTime', 'durationMinutes', 'appName'],
    order: [['startTime', 'ASC']],
  });

  const days = bucketByDay(logs);
  const totalMinutes = logs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
  const topApps = Object.entries(
    logs.reduce((acc, l) => { acc[l.appName] = (acc[l.appName] || 0) + (l.durationMinutes || 0); return acc; }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  res.json({ period: { from: start.toISOString().split('T')[0], to: end.toISOString().split('T')[0] }, totalMinutes, dailyBreakdown: days, topApps });
};

/**
 * The whole family's week in one request.
 *
 * The dashboard's screen-time chart is a sum across every child, and it built
 * that sum by listing the children and then calling `/reports/:childId/weekly`
 * once per child — so a family with four children opened its home screen with
 * five serial round trips (the fan-out cannot even start until the child list
 * comes back) and five separate week-long scans of the activity log, then threw
 * away everything except `dailyBreakdown` from each.
 *
 * This answers the question that screen actually asks, with one round trip and
 * one query. The per-child endpoint above stays exactly as it was: the Reports
 * screen is about one child at a time and needs the `topApps` breakdown this
 * one has no use for.
 *
 * GET /reports/weekly
 */
const getFamilyWeeklySummary = async (req, res) => {
  const children = await Child.findAll({
    where: { parentId: req.user.id, isActive: true },
    attributes: ['id'],
  });

  const { start, end } = weekWindow();

  // A parent with no children has no activity, and `childId: []` would be an
  // `IN ()` — which Postgres rejects outright.
  const logs = children.length === 0 ? [] : await ActivityLog.findAll({
    where: {
      childId: children.map((c) => c.id),
      startTime: { [Op.between]: [start, end] },
    },
    attributes: ['startTime', 'durationMinutes'],
  });

  res.json({
    period: { from: start.toISOString().split('T')[0], to: end.toISOString().split('T')[0] },
    children: children.length,
    totalMinutes: logs.reduce((s, l) => s + (l.durationMinutes || 0), 0),
    dailyBreakdown: bucketByDay(logs),
  });
};

module.exports = { getDailySummary, getWeeklySummary, getFamilyWeeklySummary };
