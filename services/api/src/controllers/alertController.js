const { Alert } = require('../models');
const { isUuid } = require('../utils/ids');

const getAlerts = async (req, res) => {
  const { unreadOnly } = req.query;
  const where = { parentId: req.user.id };
  if (unreadOnly === 'true') where.isRead = false;
  const alerts = await Alert.findAll({ where, order: [['createdAt', 'DESC']], limit: 50 });
  res.json(alerts);
};

const markRead = async (req, res) => {
  // A malformed id is "not found", not a database error — see utils/ids.js.
  const alert = isUuid(req.params.id)
    ? await Alert.findOne({ where: { id: req.params.id, parentId: req.user.id } })
    : null;
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  await alert.update({ isRead: true });
  res.json(alert);
};

const markAllRead = async (req, res) => {
  await Alert.update({ isRead: true }, { where: { parentId: req.user.id, isRead: false } });
  res.json({ message: 'All alerts marked as read' });
};

module.exports = { getAlerts, markRead, markAllRead };
