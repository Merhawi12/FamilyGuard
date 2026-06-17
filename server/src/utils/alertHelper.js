const { Alert, User } = require('../models');
const { sendAlertEmail } = require('./email');

/**
 * Creates an alert record, broadcasts it via Socket.io, and sends an email
 * if the parent's notification preferences allow it.
 */
const createAlert = async (io, { parentId, childId, deviceId, type, message, severity, metadata }) => {
  const alert = await Alert.create({
    parentId,
    childId,
    deviceId,
    type,
    message,
    severity,
    metadata: metadata ? JSON.stringify(metadata) : '{}',
  });

  io.to(`parent:${parentId}`).emit('alert:new', alert);

  if (severity === 'high') {
    try {
      const parent = await User.findByPk(parentId, { attributes: ['email', 'name', 'notificationPrefs'] });
      if (parent) {
        const prefs = parent.notificationPrefs ? JSON.parse(parent.notificationPrefs) : {};
        const emailEnabled = prefs.emailAlerts !== false;
        const typeEnabled = !prefs.alertTypes || prefs.alertTypes[type] !== false;
        if (emailEnabled && typeEnabled) {
          sendAlertEmail({ name: parent.name, email: parent.email, type, message, severity }).catch((err) =>
            console.error('[alertHelper] email send failed:', err.message)
          );
        }
      }
    } catch (err) {
      console.error('[alertHelper] prefs lookup failed:', err.message);
    }
  }

  return alert;
};

module.exports = { createAlert };
