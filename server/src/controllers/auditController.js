const { Op } = require('sequelize');
const { AuditLog, User } = require('../models');

const getLogs = async (req, res) => {
  try {
    const { action, userId, from, to, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (action) where.action = { [Op.like]: `${action}%` };
    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to) where.createdAt[Op.lte] = new Date(to);
    }

    const logs = await AuditLog.findAndCountAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
      limit: Math.min(parseInt(limit), 200),
      offset: parseInt(offset),
    });

    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getLogs };
