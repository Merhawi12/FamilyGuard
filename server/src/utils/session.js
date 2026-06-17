const jwt = require('jsonwebtoken');
const { Session } = require('../models');

const createSession = async (req, userId) => {
  const session = await Session.create({
    userId,
    ipAddress: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  });

  const token = jwt.sign({ id: userId, sid: session.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

  return { token, session };
};

const revokeSession = async (sessionId) => {
  await Session.update({ revoked: true, revokedAt: new Date() }, { where: { id: sessionId } });
};

const revokeAllSessions = async (userId) => {
  await Session.update(
    { revoked: true, revokedAt: new Date() },
    { where: { userId, revoked: false } }
  );
};

module.exports = { createSession, revokeSession, revokeAllSessions };
