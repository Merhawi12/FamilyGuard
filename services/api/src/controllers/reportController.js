const { Op, fn, col, literal } = require('sequelize');
const { ActivityLog, Child } = require('../models');

const getDailySummary = async (req, res) => {
  const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const { date } = req.query;
  const target = date ? new Date(date) : new Date();
  const start = new Date(target); start.setHours(0, 0, 0, 0);
  const end = new Date(target); end.setHours(23, 59, 59, 999);

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
  const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
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
