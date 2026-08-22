const { Alert } = require('../models');
const { isUuid } = require('../utils/ids');
const { auditLog } = require('../utils/auditLogger');

const SEVERITIES = ['high', 'medium', 'low'];

const getAlerts = async (req, res) => {
  const { unreadOnly } = req.query;
  const where = { parentId: req.user.id };
  if (unreadOnly === 'true') where.isRead = false;
  const alerts = await Alert.findAll({ where, order: [['createdAt', 'DESC']], limit: 50 });
  res.json(alerts);
};

const markRead = async (req, res) => {
  // A malformed id is "not found", not a database error — see utils/ids.js.
  const alert = isUuid(req.params.id)
    ? await Alert.findOne({ where: { id: req.params.id, parentId: req.user.id } })
    : null;
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  await alert.update({ isRead: true });
  res.json(alert);
};

const markAllRead = async (req, res) => {
  await Alert.update({ isRead: true }, { where: { parentId: req.user.id, isRead: false } });
  res.json({ message: 'All alerts marked as read' });
};

/**
 * DELETE /api/alerts/:id — remove one alert.
 *
 * Scoped by `parentId` in the same query that finds it, so another family's
 * alert id is "not found" rather than a 403 that confirms the row exists.
 *
 * Audited. An alert is the record that something happened on a child's device,
 * and a parental control where those can be made to disappear without trace is
 * a different product from one where they cannot — the entry is what lets a
 * second parent on the same account see that the alert was deleted rather than
 * never raised.
 */
const removeAlert = async (req, res) => {
  const alert = isUuid(req.params.id)
    ? await Alert.findOne({ where: { id: req.params.id, parentId: req.user.id } })
    : null;
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  const { type, severity } = alert;
  await alert.destroy();
  auditLog(req, {
    userId: req.user.id,
    action: 'alert.deleted',
    entity: 'Alert',
    entityId: req.params.id,
    metadata: { type, severity },
  });
  return res.json({ message: 'Alert deleted', deleted: 1 });
};

/**
 * DELETE /api/alerts — clear alerts in bulk.
 *
 * Takes the *same* filters the list does, and that is the point rather than a
 * convenience. The Alerts screen filters what it shows; a "Clear all" that
 * ignored the active filter would delete high-severity alerts a parent had
 * filtered away and was not looking at, which is the one outcome a confirmation
 * dialog cannot warn about because the parent cannot see what is about to go.
 *
 * With no filters it clears everything the account owns, which is what the
 * button says when nothing is narrowed.
 *
 * Returns the count so the caller can report what actually happened instead of
 * assuming its own list was complete — the page holds at most 50 rows and the
 * account may own far more.
 */
const clearAlerts = async (req, res) => {
  const { unreadOnly, severity } = req.query;
  const where = { parentId: req.user.id };

  if (unreadOnly === 'true') where.isRead = false;
  if (severity !== undefined && severity !== '') {
    // An unknown severity would silently widen this to "everything" once the
    // key was dropped from the clause. Refused instead.
    const wanted = String(severity).toLowerCase();
    if (!SEVERITIES.includes(wanted)) {
      return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
    }
    where.severity = wanted;
  }

  const deleted = await Alert.destroy({ where });
  auditLog(req, {
    userId: req.user.id,
    action: 'alert.cleared',
    entity: 'Alert',
    metadata: { deleted, unreadOnly: unreadOnly === 'true', severity: where.severity || null },
  });
  return res.json({ message: 'Alerts cleared', deleted });
};

module.exports = {
  getAlerts, markRead, markAllRead, removeAlert, clearAlerts,
};
