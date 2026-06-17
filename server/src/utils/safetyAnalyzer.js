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
  const children = await Child.findAll({ where: { parentId, isActive: true } });
  const findings = [];

  for (const child of children) {
    const childFindings = await analyzeChild(io, parentId, child);
    findings.push(...childFindings);
  }

  return findings;
};

const analyzeChild = async (io, parentId, child) => {
  const findings = [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const todayLogs = await ActivityLog.findAll({
    where: { childId: child.id, startTime: { [Op.between]: [todayStart, todayEnd] } },
  });

  // 1. Late-night usage
  const lateNightLogs = todayLogs.filter((log) => {
    const hour = new Date(log.startTime).getHours();
    return hour >= LATE_NIGHT_START || hour < LATE_NIGHT_END;
  });

  if (lateNightLogs.length > 0) {
    const totalLateMinutes = lateNightLogs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
    const alreadyAlerted = await Alert.findOne({
      where: {
        parentId,
        childId: child.id,
        type: 'safety_pattern',
        createdAt: { [Op.gte]: todayStart },
        message: { [Op.like]: '%late night%' },
      },
    });
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
    const alreadyAlerted = await Alert.findOne({
      where: {
        parentId,
        childId: child.id,
        type: 'safety_pattern',
        createdAt: { [Op.gte]: todayStart },
        message: { [Op.like]: '%excessive%' },
      },
    });
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

  // 3. Usage spike — compare today vs 7-day average
  const weekAgo = new Date(todayStart);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const weekLogs = await ActivityLog.findAll({
    where: { childId: child.id, startTime: { [Op.between]: [weekAgo, todayStart] } },
  });

  if (weekLogs.length > 0) {
    const weekTotalMinutes = weekLogs.reduce((s, l) => s + (l.durationMinutes || 0), 0);
    const dailyAvg = weekTotalMinutes / 7;
    if (dailyAvg > 0 && totalMinutesToday > dailyAvg * SPIKE_MULTIPLIER && totalMinutesToday > 60) {
      const alreadyAlerted = await Alert.findOne({
        where: {
          parentId,
          childId: child.id,
          type: 'safety_pattern',
          createdAt: { [Op.gte]: todayStart },
          message: { [Op.like]: '%spike%' },
        },
      });
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

module.exports = { analyzeParent };
