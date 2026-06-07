const { Device, Alert } = require('../models');

const initSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    socket.on('join:parent', (parentId) => socket.join(`parent:${parentId}`));
    socket.on('join:child', (childId) => socket.join(`child:${childId}`));

    socket.on('device:heartbeat', async ({ deviceId }) => {
      await Device.update({ lastSeen: new Date() }, { where: { id: deviceId } });
      socket.broadcast.to(`device:${deviceId}`).emit('device:online', { deviceId });
    });

    socket.on('alert:blocked_app', async ({ parentId, childId, deviceId, appName }) => {
      const alert = await Alert.create({
        parentId,
        childId,
        deviceId,
        type: 'blocked_app_attempt',
        message: `${appName} was blocked on a child device`,
        severity: 'medium',
      });
      io.to(`parent:${parentId}`).emit('alert:new', alert);
    });

    socket.on('alert:screen_time_exceeded', async ({ parentId, childId, deviceId }) => {
      const alert = await Alert.create({
        parentId,
        childId,
        deviceId,
        type: 'screen_time_exceeded',
        message: 'Daily screen time limit has been reached',
        severity: 'high',
      });
      io.to(`parent:${parentId}`).emit('alert:new', alert);
    });

    socket.on('activity:update', ({ parentId, data }) => {
      io.to(`parent:${parentId}`).emit('activity:update', data);
    });
  });
};

module.exports = initSocketHandlers;
