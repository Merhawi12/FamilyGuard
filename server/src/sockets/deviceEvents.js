const { Device, Alert, Message, Child } = require('../models');
const { createAlert } = require('../utils/alertHelper');
const { detectCyberbullying } = require('../utils/cyberbullyingDetector');

const initSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    // ── Room joins ─────────────────────────────────────────────────────────────
    socket.on('join:parent', (parentId) => socket.join(`parent:${parentId}`));
    socket.on('join:child', (childId) => socket.join(`child:${childId}`));

    // ── Device heartbeat ───────────────────────────────────────────────────────
    socket.on('device:heartbeat', async ({ deviceId }) => {
      await Device.update({ lastSeen: new Date() }, { where: { id: deviceId } });
      socket.broadcast.to(`device:${deviceId}`).emit('device:online', { deviceId });
    });

    // ── Existing alert types ───────────────────────────────────────────────────
    socket.on('alert:blocked_app', async ({ parentId, childId, deviceId, appName }) => {
      await createAlert(io, { parentId, childId, deviceId, type: 'blocked_app_attempt', message: `${appName} was blocked on a child device`, severity: 'medium' });
    });

    socket.on('alert:screen_time_exceeded', async ({ parentId, childId, deviceId }) => {
      await createAlert(io, { parentId, childId, deviceId, type: 'screen_time_exceeded', message: 'Daily screen time limit has been reached', severity: 'high' });
    });

    // ── New alert types ────────────────────────────────────────────────────────

    socket.on('alert:app_installed', async ({ parentId, childId, deviceId, appName, appPackage }) => {
      await createAlert(io, { parentId, childId, deviceId, type: 'app_installed', message: `New app installed: ${appName}`, severity: 'medium', metadata: { appName, appPackage } });
    });

    socket.on('alert:dangerous_content', async ({ parentId, childId, deviceId, url, category }) => {
      await createAlert(io, { parentId, childId, deviceId, type: 'dangerous_content', message: `Dangerous content detected (${category})`, severity: 'high', metadata: { url, category } });
    });

    socket.on('alert:unknown_contact', async ({ parentId, childId, deviceId, phoneNumber }) => {
      await createAlert(io, { parentId, childId, deviceId, type: 'unknown_contact', message: `Unknown contact attempted to reach child`, severity: 'high', metadata: { phoneNumber } });
    });

    // ── Activity stream ────────────────────────────────────────────────────────
    socket.on('activity:update', ({ parentId, data }) => {
      io.to(`parent:${parentId}`).emit('activity:update', data);
    });

    // ── Real-time location (socket path — REST path also available) ────────────
    // Mobile emits this for low-latency updates; the REST POST handles persistence.
    socket.on('location:update', ({ parentId, childId, latitude, longitude, accuracy, speed, heading, address, recordedAt }) => {
      io.to(`parent:${parentId}`).emit('location:update', {
        childId, latitude, longitude, accuracy, speed, heading, address,
        recordedAt: recordedAt || new Date().toISOString(),
      });
    });

    // ── Family chat ────────────────────────────────────────────────────────────

    // Child sends a message via socket (in addition to the REST endpoint)
    socket.on('chat:send', async ({ childId, text, messageType = 'normal', deviceId }) => {
      try {
        const child = await Child.findByPk(childId, { attributes: ['id', 'parentId'] });
        if (!child) return;

        const message = await Message.create({
          parentId: child.parentId,
          childId: child.id,
          senderId: child.id,
          senderRole: 'child',
          text: text?.trim(),
          messageType,
        });

        // Deliver to parent
        io.to(`parent:${child.parentId}`).emit('chat:message', message);

        // Confirm delivery back to sender
        socket.emit('chat:delivered', { messageId: message.id });

        if (messageType === 'emergency') {
          await createAlert(io, { parentId: child.parentId, childId: child.id, type: 'emergency_button', message: `Emergency alert from child: ${text?.trim()}`, severity: 'high', metadata: { messageId: message.id, deviceId } });
        }

        const { detected, matchedKeywords } = detectCyberbullying(text?.trim());
        if (detected) {
          await createAlert(io, { parentId: child.parentId, childId: child.id, type: 'cyberbullying', message: 'Possible cyberbullying detected in child message', severity: 'high', metadata: { messageId: message.id, matchedKeywords } });
        }
      } catch (err) {
        console.error('[socket] chat:send error:', err.message);
      }
    });

    // Parent sends a message via socket (mirrors the REST endpoint)
    socket.on('chat:reply', async ({ parentId, childId, text, messageType = 'normal' }) => {
      try {
        const message = await Message.create({
          parentId,
          childId,
          senderId: parentId,
          senderRole: 'parent',
          text: text?.trim(),
          messageType,
        });

        io.to(`child:${childId}`).emit('chat:message', message);
        socket.emit('chat:delivered', { messageId: message.id });
      } catch (err) {
        console.error('[socket] chat:reply error:', err.message);
      }
    });
  });
};

module.exports = initSocketHandlers;
