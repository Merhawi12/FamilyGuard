const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { Session, Child } = require('../models');
const { env } = require('../config/env');
const { DEVICE_UNLINKED } = require('./deviceAccess');

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

/**
 * Cut the user's live realtime feed as well as their REST access.
 *
 * The handshake check in `sockets/auth.js` only runs when a socket connects, so
 * revoking a session on its own would leave an already-open socket streaming
 * location fixes, alerts and chat to someone who has just been signed out or
 * blocked. Rooms are named `parent:<userId>` by `sockets/deviceEvents.js`.
 *
 * `io` is optional: callers outside a request (jobs, scripts) simply do not have
 * one, and the handshake check still stops the token being reused.
 */
const disconnectUserSockets = (io, userId) => {
  if (!io) return;
  io.in(`parent:${userId}`).disconnectSockets(true);
};

/**
 * The same cut for a child device whose access has just been revoked.
 *
 * `sockets/auth.js` refuses a revoked device at the handshake, but a phone that
 * was already connected keeps the socket it has: removing a device left it
 * streaming location and chat, and still able to raise alerts, until it happened
 * to reconnect. Rooms are named `device:<deviceId>` by `sockets/deviceEvents.js`.
 *
 * The event before the disconnect is what turns "this phone stops working" into
 * "this phone knows it was unlinked", so it can drop its credentials and offer
 * the linking screen instead of sitting on a Linked badge and retrying forever.
 * It is best effort — a phone that is offline right now never sees it — and the
 * guarantee stays where it was: the handshake refuses the reconnect with the
 * same `device_unlinked` code, and so does every REST call.
 */
const disconnectDeviceSockets = (io, deviceId) => {
  if (!io) return;
  io.to(`device:${deviceId}`).emit('device:unlinked', { deviceId, code: DEVICE_UNLINKED });
  io.in(`device:${deviceId}`).disconnectSockets(true);
};

/**
 * Cut every live socket belonging to a family — the parent's own, and each of
 * their children's devices.
 *
 * Blocking an account revoked its sessions and disconnected `parent:<id>`, but
 * child sockets are deliberately not in that room (they would receive the whole
 * household's alerts and locations), so every child device kept its open socket
 * and went on streaming. The handshake now refuses them, but that only runs on
 * connect — this is what closes the ones already open.
 */
const disconnectFamilySockets = async (io, parentId) => {
  if (!io) return;
  disconnectUserSockets(io, parentId);

  const children = await Child.findAll({ where: { parentId }, attributes: ['id'] });
  for (const child of children) io.in(`child:${child.id}`).disconnectSockets(true);
};

const revokeSession = async (sessionId, io) => {
  const session = await Session.findByPk(sessionId, { attributes: ['id', 'userId'] });
  await Session.update({ revoked: true, revokedAt: new Date() }, { where: { id: sessionId } });
  if (session) disconnectUserSockets(io, session.userId);
};

/**
 * Revoke every session for a user except the one making the request.
 *
 * Used by a password change, where the point is to evict whoever else holds a
 * token while keeping the person doing the eviction signed in. Returns how many
 * were cut so the caller can say so.
 *
 * `keepSessionId` is optional: a token minted without a `sid` claim leaves
 * `req.sessionId` undefined, and passing that to `Op.ne` would match nothing and
 * silently revoke none. Absent, this degrades to revoking all of them — the
 * safe direction.
 */
const revokeOtherSessions = async (userId, keepSessionId, io) => {
  const where = { userId, revoked: false };
  if (keepSessionId) where.id = { [Op.ne]: keepSessionId };

  const [count] = await Session.update(
    { revoked: true, revokedAt: new Date() },
    { where }
  );

  /*
   * Disconnects the whole `parent:<userId>` room, the caller's own socket
   * included — there is no per-session socket room to be more surgical with.
   * Harmless: the client reconnects automatically and its token is still valid,
   * whereas the revoked sessions' sockets fail the handshake and stay out.
   */
  if (count > 0) disconnectUserSockets(io, userId);
  return count;
};

const revokeAllSessions = async (userId, io) => {
  await Session.update(
    { revoked: true, revokedAt: new Date() },
    { where: { userId, revoked: false } }
  );
  disconnectUserSockets(io, userId);
};

module.exports = {
  createSession, revokeSession, revokeAllSessions, revokeOtherSessions,
  disconnectUserSockets, disconnectDeviceSockets, disconnectFamilySockets,
};
