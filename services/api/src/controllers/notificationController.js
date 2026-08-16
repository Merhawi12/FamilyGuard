const { Notification, User } = require('../models');
const { Op } = require('sequelize');
const { auditLog } = require('../utils/auditLogger');
const { STAFF_ROLES } = require('../config/roles');
const { parsePagination } = require('../utils/pagination');
const { isUuid } = require('../utils/ids');

// GET /api/notifications — the current user's own notifications
const listMine = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 100, defaultLimit: 100 });
    const notifications = await Notification.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    res.json(notifications);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/notifications/:id/read
const markRead = async (req, res, next) => {
  try {
    // A malformed id is "not found", not a database error — see utils/ids.js.
    const notification = isUuid(req.params.id)
      ? await Notification.findOne({ where: { id: req.params.id, userId: req.user.id } })
      : null;
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    await notification.update({ isRead: true });
    res.json(notification);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/notifications/read-all
const markAllRead = async (req, res, next) => {
  try {
    await Notification.update({ isRead: true }, { where: { userId: req.user.id, isRead: false } });
    res.json({ message: 'All notifications marked read' });
  } catch (err) {
    next(err);
  }
};

// POST /api/notifications — admin sends to one user or broadcasts to everyone
const send = async (req, res, next) => {
  try {
    const { userId, broadcast, title, message, type = 'info' } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    if (!userId && !broadcast) return res.status(400).json({ error: 'Provide userId or broadcast: true' });

    let recipients;
    if (broadcast) {
      // A broadcast is a customer announcement — no department account should receive it.
      recipients = await User.findAll({
        where: { role: { [Op.notIn]: STAFF_ROLES } },
        attributes: ['id'],
      });
    } else {
      const user = await User.findByPk(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      recipients = [user];
    }

    const rows = await Notification.bulkCreate(
      recipients.map((u) => ({ userId: u.id, title, message, type, createdBy: req.user.id })),
      // Postgres needs telling to hand the generated ids back; without them the
      // broadcast below would push rows the client cannot key or mark read.
      { returning: true },
    );

    /**
     * Delivered, not just filed.
     *
     * This wrote the rows and stopped. The bell polls once a minute, so an
     * announcement took up to a minute to appear on a dashboard that was open
     * the whole time — and the socket every signed-in parent already holds was
     * sitting there unused. A maintenance notice is worth arriving when it is
     * sent.
     *
     * Emitted per recipient rather than broadcast to everyone, because a
     * notification row belongs to one account: the client marks it read by id,
     * and a shared payload would put another customer's row in this customer's
     * bell. `parent:<userId>` is the room every authenticated non-device socket
     * joins (see sockets/deviceEvents.js), staff included.
     *
     * Best effort, and after the write: a socket layer that is unavailable must
     * not turn a stored announcement into a failed request.
     */
    const io = req.app.get('io');
    if (io) {
      for (const row of rows) {
        try {
          io.to(`parent:${row.userId}`).emit('notification:new', row);
        } catch {
          /* one undeliverable socket must not abort the rest of the send */
        }
      }
    }

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.notification_sent',
      entity: 'Notification',
      metadata: { broadcast: !!broadcast, userId: broadcast ? null : userId, title, recipientCount: rows.length },
    });

    res.status(201).json({ message: `Sent to ${rows.length} recipient(s)`, count: rows.length });
  } catch (err) {
    next(err);
  }
};

// GET /api/notifications/sent — admin's view of what's been sent
const listSent = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    // findAndCountAll so the console can page — a broadcast writes one row per
    // customer, so this table grows far faster than the others.
    const notifications = await Notification.findAndCountAll({
      where: { createdBy: { [Op.ne]: null } },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    res.json(notifications);
  } catch (err) {
    next(err);
  }
};

module.exports = { listMine, markRead, markAllRead, send, listSent };
