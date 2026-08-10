const { Session, User } = require('../models');
const { auditLog } = require('../utils/auditLogger');
const { revokeSession, revokeAllSessions } = require('../utils/session');
const { parsePagination } = require('../utils/pagination');
const { isUuid } = require('../utils/ids');

// GET /admin/sessions/active — non-revoked sessions, joined with their user.
// Paginated: an active fleet can run to thousands of rows.
const listActiveSessions = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });

    const sessions = await Session.findAndCountAll({
      where: { revoked: false },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] }],
      order: [['lastActiveAt', 'DESC']],
      limit,
      offset,
    });

    res.json(sessions);
  } catch (err) {
    next(err);
  }
};

// GET /admin/users/:id/sessions
const listUserSessions = async (req, res, next) => {
  try {
    // A malformed id has no sessions rather than being a database error — see
    // utils/ids.js.
    if (!isUuid(req.params.id)) return res.json([]);

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
    // A malformed id is "not found", not a database error — see utils/ids.js.
    const session = isUuid(req.params.sessionId)
      ? await Session.findByPk(req.params.sessionId)
      : null;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await revokeSession(session.id, req.app.get('io'));
    auditLog(req, { userId: req.user.id, action: 'admin.session_revoked', entity: 'Session', entityId: session.id, metadata: { targetUserId: session.userId } });

    res.json({ message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/users/:id/sessions — force logout everywhere
const forceLogoutUser = async (req, res, next) => {
  try {
    // See utils/ids.js — a malformed id must not reach the UPDATE as a UUID.
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'User not found' });

    await revokeAllSessions(req.params.id, req.app.get('io'));
    auditLog(req, { userId: req.user.id, action: 'admin.user_logged_out_everywhere', entity: 'User', entityId: req.params.id });

    res.json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
};

module.exports = { listActiveSessions, listUserSessions, forceLogoutSession, forceLogoutUser };
