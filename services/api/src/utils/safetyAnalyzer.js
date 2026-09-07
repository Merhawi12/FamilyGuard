const { Op } = require('sequelize');
const { ActivityLog, Alert, Child } = require('../models');
const { createAlert } = require('./alertHelper');

const LATE_NIGHT_START = 22; // 10 PM
const LATE_NIGHT_END = 6;    // 6 AM
const EXCESSIVE_MINUTES = 300; // 5 hours
const SPIKE_MULTIPLIER = 2.5;  // 2.5x normal daily average

/**
 * Runs pattern-based safety analysis for all children of a parent.
 * Called once per hour from the server scheduler.
 */
const analyzeParent = async (io, parentId) => {
  // Two columns: the id every query below keys on, and the name the alert text
  // uses. This selected whole child rows — avatar urls and all — once an hour
  // for every parent on the platform.
  const children = await Child.findAll({
    where: { parentId, isActive: true },
    attributes: ['id', 'name'],
  });
  const findings = [];

  for (const child of children) {
    const childFindings = await analyzeChild(io, parentId, child);
    findings.push(...childFindings);
  }

  return findings;
};

/**
 * The phrase in each alert's message that identifies which pattern raised it.
 *
 * ── These were wrong, and the symptom was not a missing alert ────────────────
 *
 * The dedupe below used to be spelled inline, as `message LIKE '%late night%'`
 * and `message LIKE '%excessive%'`. Neither string occurs in the message it was
 * meant to recognise: the late-night alert says "late at night", and the
 * excessive-usage one says "unusually high" — the word "excessive" appears only
 * in the constant name and the metadata. So both checks matched nothing, every
 * hour, for ever.
 *
 * `createAlert` does not deduplicate, so what that produced was not a missed
 * alert but a repeated one: a child over the five-hour limit at 18:00 raised a
 * fresh alert on every pass until midnight — six identical rows, six emails and
 * six push notifications about one afternoon. The spike check used `%spike%`,
 * which does appear in its message, and was the only one of the three that
 * worked; the job's own header comment ("only raises an alert when one does not
 * already exist") described what all three were supposed to do.
 *
 * Naming them here is what keeps the fragment and the message together, so the
 * next edit to either has to look at the other. tests/safetyAnalysis.test.js
 * asserts that each fragment really is a substring of the message it guards.
 */
const PATTERN_TEXT = {
  lateNight: 'late at night',
  excessive: 'unusually high',
  spike: 'unusual spike detected',
};

/**
 * Whether this child has already been alerted today about a given pattern.
 *
 * Reads as a closure over one query rather than issuing its own. There were
 * three `Alert.findOne`s below, each with a `message LIKE '%…%'` — a leading
 * wildcard, so no index can serve it and every one was a scan of the alerts
 * table. Run hourly for every child of every parent, that was the most
 * expensive thing this job did, to answer a question about at most three rows.
 *
 * The match is still on the message text, deliberately. `metadata.pattern` is
 * the better key and is written on every new row, but rows created before it
 * existed do not carry it — and a dedupe check that silently stops recognising
 * old alerts would re-alert a parent about a pattern they have already seen.
 */
const alertedToday = (alerts) => (fragment) =>
  alerts.some((alert) => (alert.message || '').includes(fragment));

const analyzeChild = async (io, parentId, child) => {
  const findings = [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const weekAgo = new Date(todayStart);
  weekAgo.setDate(weekAgo.getDate() - 7);

  /**
   * One pass over the activity, and one over today's alerts.
   *
   * This was four queries per child per hour — today's logs, last week's logs,
   * and up to three `LIKE` scans for the dedupe — and the two log queries
   * selected every column of every row. That matters more than the bytes:
   * `ActivityLog.afterFind` decrypts `url`, so an hourly background job was
   * running an AES decrypt over a week of every child's browsing history to add
   * up two numeric columns it does not read the url for at all.
   *
   * The two windows are adjacent, so they are fetched as one range and split
   * below. Projecting the two columns actually used is what makes that cheap
   * enough to be worth doing in one go.
   */
  const [logs, todaysAlerts] = await Promise.all([
    ActivityLog.findAll({
      where: { childId: child.id, startTime: { [Op.between]: [weekAgo, todayEnd] } },
      attributes: ['startTime', 'durationMinutes'],
      raw: true,
    }),
    Alert.findAll({
      where: {
        parentId,
        childId: child.id,
        type: 'safety_pattern',
        createdAt: { [Op.gte]: todayStart },
      },
      attributes: ['message'],
      raw: true,
    }),
  ]);

  const alreadyAlertedAbout = alertedToday(todaysAlerts);

  // The boundary is `todayStart` inclusive, matching the two `Op.between`
  // windows this replaces: the week ran up to it, today runs from it.
  const todayLogs = [];
  const weekLogs = [];
  for (const log of logs) {
    const at = new Date(log.startTime);
    if (at >= todayStart) todayLogs.push(log);
    else weekLogs.push(log);
  }

  // 1. Late-night usage
  const lateNightLogs = todayLogs.filter((log) => {
    const hour = new Date(log.startTime).getHours();
    return hour >= LATE_NIGHT_START || hour < LATE_NIGHT_END;
  });

  if (lateNightLogs.length > 0) {
    const totalLateMinutes = lateNightLogs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
    const alreadyAlerted = alreadyAlertedAbout(PATTERN_TEXT.lateNight);
    if (!alreadyAlerted && totalLateMinutes >= 10) {
      const alert = await createAlert(io, {
        parentId,
        childId: child.id,
        type: 'safety_pattern',
        message: `${child.name} used devices late at night (${totalLateMinutes} min after 10 PM)`,
        severity: 'high',
        metadata: { pattern: 'late_night', minutes: totalLateMinutes },
      });
      findings.push(alert);
    }
  }

  // 2. Excessive total usage today
  const totalMinutesToday = todayLogs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
  if (totalMinutesToday >= EXCESSIVE_MINUTES) {
    const alreadyAlerted = alreadyAlertedAbout(PATTERN_TEXT.excessive);
    if (!alreadyAlerted) {
      const alert = await createAlert(io, {
        parentId,
        childId: child.id,
        type: 'safety_pattern',
        message: `${child.name} has had ${Math.round(totalMinutesToday / 60 * 10) / 10} hours of screen time today — unusually high`,
        severity: 'high',
        metadata: { pattern: 'excessive_usage', minutes: totalMinutesToday },
      });
      findings.push(alert);
    }
  }

  // 3. Usage spike — compare today vs 7-day average. `weekLogs` is the same
  // fetch as `todayLogs`, split at midnight; see the query above.
  if (weekLogs.length > 0) {
    const weekTotalMinutes = weekLogs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
    const dailyAvg = weekTotalMinutes / 7;
    if (dailyAvg > 0 && totalMinutesToday > dailyAvg * SPIKE_MULTIPLIER && totalMinutesToday > 60) {
      const alreadyAlerted = alreadyAlertedAbout(PATTERN_TEXT.spike);
      if (!alreadyAlerted) {
        const alert = await createAlert(io, {
          parentId,
          childId: child.id,
          type: 'safety_pattern',
          message: `${child.name}'s screen time today is ${Math.round(totalMinutesToday / dailyAvg * 10) / 10}x their 7-day average — unusual spike detected`,
          severity: 'high',
          metadata: { pattern: 'usage_spike', todayMinutes: totalMinutesToday, avgMinutes: Math.round(dailyAvg) },
        });
        findings.push(alert);
      }
    }
  }

  return findings;
};

// `PATTERN_TEXT` is exported for tests/safetyAnalysis.test.js, which asserts each
// fragment is really a substring of the message it deduplicates — the check that
// would have caught the two that never matched.
module.exports = { analyzeParent, PATTERN_TEXT };
