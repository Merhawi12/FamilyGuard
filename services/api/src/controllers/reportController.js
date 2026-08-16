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

const getWeeklySummary = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const end = new Date();
  const start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);

  const logs = await ActivityLog.findAll({
    where: { childId: child.id, startTime: { [Op.between]: [start, end] } },
    order: [['startTime', 'ASC']],
  });

  const days = {};
  logs.forEach((l) => {
    const day = l.startTime.toISOString().split('T')[0];
    days[day] = (days[day] || 0) + (l.durationMinutes || 0);
  });

  const totalMinutes = logs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
  const topApps = Object.entries(
    logs.reduce((acc, l) => { acc[l.appName] = (acc[l.appName] || 0) + (l.durationMinutes || 0); return acc; }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  res.json({ period: { from: start.toISOString().split('T')[0], to: end.toISOString().split('T')[0] }, totalMinutes, dailyBreakdown: days, topApps });
};

module.exports = { getDailySummary, getWeeklySummary };
