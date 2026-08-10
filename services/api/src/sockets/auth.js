const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { User, Child, Device, Session } = require('../models');
const { DEVICE_UNLINKED, ACCOUNT_SUSPENDED } = require('../utils/deviceAccess');

/**
 * A handshake refusal the client can branch on.
 *
 * Socket.IO delivers `err.message` and `err.data` to `connect_error`, so the
 * code rides alongside the sentence rather than having to be parsed out of it.
 * The child app reads `data.code` to decide whether to forget its credentials
 * (see utils/deviceAccess.js for why that distinction exists).
 */
const refuse = (message, code) => {
  const error = new Error(message);
  error.data = { code };
  return error;
};

/**
 * Socket.IO handshake authentication.
 *
 * Every socket must present a valid JWT — either a parent session token or a
 * child device token. The identity decoded here is stored on `socket.data` and
 * is the only source of truth for room membership; ids supplied by the client
 * are never trusted (see sockets/deviceEvents.js).
 */
const attachSocketAuth = (io) => {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, env.auth.jwtSecret);

      if (decoded.deviceId && decoded.childId) {
        const device = await Device.findByPk(decoded.deviceId);
        if (!device || !device.isActive) {
          return next(refuse('This device is no longer linked', DEVICE_UNLINKED));
        }

        const child = await Child.findByPk(decoded.childId, { attributes: ['id', 'parentId', 'isActive'] });
        // A token whose child no longer exists is as dead as one whose device
        // does not, and the phone should treat it the same way.
        if (!child) return next(refuse('This device is no longer linked', DEVICE_UNLINKED));

        /**
         * The same chain the REST middleware walks, for the same reason: a
         * device is only as authorised as the family above it. Without this a
         * blocked parent's child devices kept a live socket — streaming
         * location, raising alerts and carrying chat — even once every REST call
         * they made was refused.
         */
        if (!child.isActive) return next(refuse('Device access is suspended', ACCOUNT_SUSPENDED));
        const owner = await User.findByPk(child.parentId, { attributes: ['id', 'isActive'] });
        if (!owner || !owner.isActive) {
          return next(refuse('Device access is suspended', ACCOUNT_SUSPENDED));
        }

        socket.data.role = 'child';
        socket.data.deviceId = decoded.deviceId;
        socket.data.childId = decoded.childId;
        socket.data.parentId = child.parentId;
        return next();
      }

      if (decoded.id) {
        // A pre-auth token (first MFA factor only) must not open a socket.
        if (decoded.mfaRequired) return next(new Error('MFA not completed'));

        // Signing out, an admin force-logout, a password reset and a role change
        // all work by revoking the Session row. The REST middleware honours that;
        // without the same check here a revoked token kept a live socket — so a
        // locked-out account carried on receiving its family's alerts, locations
        // and chat until the JWT expired days later.
        if (decoded.sid) {
          const session = await Session.findByPk(decoded.sid, { attributes: ['id', 'revoked'] });
          if (!session || session.revoked) return next(new Error('Session expired'));
        }

        const user = await User.findByPk(decoded.id, { attributes: ['id', 'isActive'] });
        if (!user || !user.isActive) return next(new Error('Unauthorized'));

        socket.data.role = 'parent';
        socket.data.parentId = user.id;
        return next();
      }

      return next(new Error('Invalid token'));
    } catch {
      return next(new Error('Invalid token'));
    }
  });
};

module.exports = attachSocketAuth;
