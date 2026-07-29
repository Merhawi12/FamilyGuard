const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { User, Child, Device } = require('../models');

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
        if (!device || !device.isActive) return next(new Error('Device revoked'));

        const child = await Child.findByPk(decoded.childId, { attributes: ['id', 'parentId'] });
        if (!child) return next(new Error('Child not found'));

        socket.data.role = 'child';
        socket.data.deviceId = decoded.deviceId;
        socket.data.childId = decoded.childId;
        socket.data.parentId = child.parentId;
        return next();
      }

      if (decoded.id) {
        // A pre-auth token (first MFA factor only) must not open a socket.
        if (decoded.mfaRequired) return next(new Error('MFA not completed'));

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
