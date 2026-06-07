const { Op } = require('sequelize');
const { ActivityLog, Child, Device, Alert } = require('../models');

const getActivity = async (req, res) => {
  const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const { from, to, limit = 50, offset = 0 } = req.query;
  const where = { childId: child.id };
  if (from || to) {
    where.startTime = {};
    if (from) where.startTime[Op.gte] = new Date(from);
    if (to) where.startTime[Op.lte] = new Date(to);
  }

  const logs = await ActivityLog.findAndCountAll({
    where,
    include: ['device'],
    order: [['startTime', 'DESC']],
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
  res.json(logs);
};

const logActivity = async (req, res) => {
  try {
    const { deviceId, childId, appName, appPackage, category, startTime, endTime, durationMinutes, url } = req.body;
    const log = await ActivityLog.create({ deviceId, childId, appName, appPackage, category, startTime, endTime, durationMinutes, url });

    await Device.update({ lastSeen: new Date() }, { where: { id: deviceId } });
    res.status(201).json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getActivity, logActivity };
