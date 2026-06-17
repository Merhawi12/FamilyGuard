const { Notification, User } = require('../models');
const { Op } = require('sequelize');
const { auditLog } = require('../utils/auditLogger');

// GET /api/notifications — the current user's own notifications
const listMine = async (req, res) => {
  try {
    const notifications = await Notification.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit: 100,
    });
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PATCH /api/notifications/:id/read
const markRead = async (req, res) => {
  try {
    const notification = await Notification.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    await notification.update({ isRead: true });
    res.json(notification);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PATCH /api/notifications/read-all
const markAllRead = async (req, res) => {
  try {
    await Notification.update({ isRead: true }, { where: { userId: req.user.id, isRead: false } });
    res.json({ message: 'All notifications marked read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/notifications — admin sends to one user or broadcasts to everyone
const send = async (req, res) => {
  try {
    const { userId, broadcast, title, message, type = 'info' } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    if (!userId && !broadcast) return res.status(400).json({ error: 'Provide userId or broadcast: true' });

    let recipients;
    if (broadcast) {
      recipients = await User.findAll({ where: { role: { [Op.ne]: 'admin' } }, attributes: ['id'] });
    } else {
      const user = await User.findByPk(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      recipients = [user];
    }

    const rows = await Notification.bulkCreate(
      recipients.map((u) => ({ userId: u.id, title, message, type, createdBy: req.user.id }))
    );

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.notification_sent',
      entity: 'Notification',
      metadata: { broadcast: !!broadcast, userId: broadcast ? null : userId, title, recipientCount: rows.length },
    });

    res.status(201).json({ message: `Sent to ${rows.length} recipient(s)`, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/notifications/sent — admin's view of what's been sent
const listSent = async (req, res) => {
  try {
    const notifications = await Notification.findAll({
      where: { createdBy: { [Op.ne]: null } },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { listMine, markRead, markAllRead, send, listSent };
