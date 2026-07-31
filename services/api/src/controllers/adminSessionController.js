const { Session, User } = require('../models');
const { auditLog } = require('../utils/auditLogger');
const { revokeSession, revokeAllSessions } = require('../utils/session');

// GET /admin/sessions/active — non-revoked sessions, joined with their user.
// Paginated: an active fleet can run to thousands of rows.
const listActiveSessions = async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const sessions = await Session.findAndCountAll({
      where: { revoked: false },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
      order: [['lastActiveAt', 'DESC']],
      limit: Math.min(parseInt(limit), 200),
      offset: parseInt(offset),
    });

    res.json(sessions);
  } catch (err) {
    next(err);
  }
};

// GET /admin/users/:id/sessions
const listUserSessions = async (req, res, next) => {
  try {
    const sessions = await Session.findAll({
      where: { userId: req.params.id },
      order: [['createdAt', 'DESC']],
    });
    res.json(sessions);
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/sessions/:sessionId — force logout one device
const forceLogoutSession = async (req, res, next) => {
  try {
    const session = await Session.findByPk(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await revokeSession(session.id);
    auditLog(req, { userId: req.user.id, action: 'admin.session_revoked', entity: 'Session', entityId: session.id, metadata: { targetUserId: session.userId } });

    res.json({ message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/users/:id/sessions — force logout everywhere
const forceLogoutUser = async (req, res, next) => {
  try {
    await revokeAllSessions(req.params.id);
    auditLog(req, { userId: req.user.id, action: 'admin.user_logged_out_everywhere', entity: 'User', entityId: req.params.id });

    res.json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
};

module.exports = { listActiveSessions, listUserSessions, forceLogoutSession, forceLogoutUser };
