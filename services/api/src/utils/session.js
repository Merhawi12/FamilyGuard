const jwt = require('jsonwebtoken');
const { Session } = require('../models');
const { env } = require('../config/env');

const createSession = async (req, userId) => {
  const session = await Session.create({
    userId,
    ipAddress: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  });

  const token = jwt.sign({ id: userId, sid: session.id }, env.auth.jwtSecret, {
    expiresIn: env.auth.jwtExpiresIn,
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
