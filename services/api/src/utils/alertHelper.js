const { Alert, User } = require('../models');
const { sendAlertEmail } = require('./email');
// Called through the module rather than destructured so the send stays
// interceptable — the tests assert on what an alert actually dispatches.
const pushService = require('./pushService');
const { getMutedAlertTypes } = require('./alertDelivery');
const logger = require('./logger');

/** Where tapping the notification should take the parent. */
const ALERT_DESTINATION = '/dashboard/alerts';

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

  try {
    // An operator can hold one alert type back from email and push when it is
    // flooding — the record above and the broadcast beside it are unaffected, so
    // the parent still sees it the moment they look. See utils/alertDelivery.js.
    const muted = await getMutedAlertTypes();
    if (muted.includes(type)) return alert;

    const parent = await User.findByPk(parentId, { attributes: ['email', 'name', 'notificationPrefs'] });
    if (parent) {
      const prefs = parent.notificationPrefs ? JSON.parse(parent.notificationPrefs) : {};

      const emailEnabled = prefs.emailAlerts !== false;
      const typeEnabled = !prefs.alertTypes || prefs.alertTypes[type] !== false;
      // The settings screen offers "High severity only", and it defaults to on.
      // This used to email on high severity unconditionally, so switching it off
      // changed nothing — a parent who asked for every alert still got only the
      // critical ones.
      const highOnly = prefs.emailHighOnly !== false;
      const severityAllowed = severity === 'high' || !highOnly;

      // An account created from a phone number has no address. Sending here
      // anyway would hand nodemailer a null `to`, which throws inside the
      // alert pipeline and takes the push notification down with it — so the
      // channel is skipped and the others still run.
      if (parent.email && emailEnabled && typeEnabled && severityAllowed) {
        /**
         * Still not awaited — the alert is recorded and broadcast regardless —
         * but the *result* is now read. `mailer.send` reports failure by
         * resolving false rather than throwing, so the `.catch` this replaces
         * could never run: an undelivered alert email produced no log at all,
         * including for `emergency_button`. Nothing told anyone that the one
         * channel a parent is not already looking at had silently stopped.
         */
        sendAlertEmail({ name: parent.name, email: parent.email, type, message, severity })
          .then((delivered) => {
            if (!delivered) logger.error('Alert email was not delivered', { alertId: alert.id, type, severity });
          })
          .catch((err) => logger.error('Alert email failed', { alertId: alert.id, error: err.message }));
      }

      // Push follows the same per-type preference as email but has its own
      // switch, and ignores the "high severity only" setting — that one is
      // written against a mailbox a parent reads later, whereas a push is the
      // channel they asked to be interrupted on.
      const pushEnabled = prefs.pushAlerts !== false;
      if (pushEnabled && typeEnabled) {
        // Deliberately not awaited: an alert must be recorded and broadcast even
        // if a push service is slow or down.
        pushService.sendToUser(parentId, {
          title: severity === 'high' ? 'Parentix — urgent alert' : 'Parentix alert',
          body: message,
          data: { type: 'alert', alertType: type, alertId: alert.id, childId, severity, url: ALERT_DESTINATION },
        }).catch((err) => logger.error('Alert push failed', { error: err.message }));
      }
    }
  } catch (err) {
    logger.error('Alert preference lookup failed', { error: err.message });
  }

  return alert;
};

module.exports = { createAlert };
