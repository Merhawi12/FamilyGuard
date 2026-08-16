const { Op } = require('sequelize');
const { AuditLog, User, PushToken, Alert } = require('../models');
const { LEVELS, levelFor, serviceFor, levelCondition } = require('../utils/logSeverity');
const { getSetting, setSetting } = require('../utils/settings');
const { getMutedAlertTypes, setMutedAlertTypes } = require('../utils/alertDelivery');
const { ALERT_TYPES, ALERT_TYPE_KEYS } = require('../config/alertTypes');
const { auditLog } = require('../utils/auditLogger');
const { webPushAvailable } = require('../utils/pushService');
const { isEnabled: mailIsEnabled } = require('../services/mailer');
const { env } = require('../config/env');

/**
 * Platform health for the console's Overview — what the platform has been
 * telling itself, and whether anything has been said about it.
 *
 * Every number is counted from the audit stream, using the same severity rules
 * the System Logs screen filters by (`utils/logSeverity.js`). That is deliberate:
 * a summary derived by a second, private rule set would put a count on the
 * Overview that the screen it links to could not reproduce.
 *
 * There is no metrics pipeline behind this — no CPU, no latency, no error rate.
 * The platform records what it *did*, so the summary reports actions, and the
 * screen says so rather than implying a monitor nobody built.
 */

const WINDOWS = {
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
};

const ACK_KEY = 'criticalAcknowledgement';

const HISTORY_LIMIT = 6;

/** One entry, flattened the way the console reads it. */
const entryOf = (row) => {
  const log = row.toJSON ? row.toJSON() : row;
  return {
    id: log.id,
    action: log.action,
    entity: log.entity,
    createdAt: log.createdAt,
    level: levelFor(log.action),
    service: serviceFor(log.action),
    actor: log.user ? { id: log.user.id, name: log.user.name, email: log.user.email } : null,
  };
};

/** The delivery channels an alert can actually leave the platform by. */
const channels = async () => {
  /**
   * Asked of the mailer, not of the provider name.
   *
   * `provider !== 'none'` was always true in production, because Terraform sets
   * EMAIL_PROVIDER=smtp on the service whether or not a relay has been supplied.
   * So this tile reported email as active — with the from-address beside it —
   * on a deployment that was sending nothing at all. It is the screen an
   * operator checks to answer "is mail working", and it was answering yes.
   *
   * `isEnabled()` is the same test the send path takes, so the tile and the
   * behaviour cannot disagree.
   */
  const emailConfigured = mailIsEnabled();
  const pushConfigured = webPushAvailable();
  const subscriptions = pushConfigured ? await PushToken.count() : 0;

  return [
    {
      key: 'email',
      label: 'Email',
      status: emailConfigured ? 'active' : 'inactive',
      detail: emailConfigured
        ? env.email.from
        : 'No relay configured — alert mail is written to the log instead of sent',
    },
    {
      key: 'push',
      label: 'Browser push',
      status: pushConfigured ? 'active' : 'inactive',
      detail: pushConfigured
        ? `${subscriptions} subscribed ${subscriptions === 1 ? 'browser' : 'browsers'}`
        : 'No VAPID keypair configured — nothing can be pushed',
    },
    {
      // Listed rather than hidden: the reference design asks for it, parents ask
      // for it, and the honest answer is that no provider is integrated. A
      // "Configure" button here would lead nowhere.
      key: 'sms',
      label: 'SMS',
      status: 'unavailable',
      detail: 'Not integrated — the platform has no SMS provider',
    },
  ];
};

// GET /admin/platform-health?window=24h
const getPlatformHealth = async (req, res, next) => {
  try {
    const key = WINDOWS[req.query.window] ? req.query.window : '24h';
    const window = WINDOWS[key];
    const since = new Date(Date.now() - window.ms);

    const [counts, latestCritical, recent, acknowledgement, muted, deliveryChannels, alerts] = await Promise.all([
      // One count per level, each built from the same condition the log filter
      // uses, so a tile and the screen behind it can never disagree.
      Promise.all(LEVELS.map((level) => AuditLog.count({
        where: { [Op.and]: [{ createdAt: { [Op.gte]: since } }, levelCondition(level)] },
      }).then((count) => ({ level, count })))),

      AuditLog.findOne({
        where: { [Op.and]: [{ createdAt: { [Op.gte]: since } }, levelCondition('critical')] },
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
        order: [['createdAt', 'DESC']],
      }),

      AuditLog.findAll({
        where: {
          [Op.and]: [
            { createdAt: { [Op.gte]: since } },
            { [Op.or]: [levelCondition('critical'), levelCondition('error'), levelCondition('warning')] },
          ],
        },
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
        order: [['createdAt', 'DESC']],
        limit: HISTORY_LIMIT,
      }),

      getSetting(ACK_KEY, null),
      getMutedAlertTypes(),
      channels(),
      // Alerts raised to families in the window — a different stream from the
      // audit log, and the one that says whether the alert types below are
      // firing at all.
      Alert.count({ where: { createdAt: { [Op.gte]: since } } }),
    ]);

    const critical = latestCritical ? entryOf(latestCritical) : null;

    res.json({
      window: key,
      windowLabel: window.label,
      windows: Object.entries(WINDOWS).map(([value, w]) => ({ value, label: w.label })),
      levels: counts,
      familyAlerts: alerts,
      critical: critical && {
        entry: critical,
        // An acknowledgement is of one entry, so a newer critical entry brings
        // the banner back rather than staying dismissed under it.
        acknowledged: acknowledgement?.entryId === critical.id,
        acknowledgedBy: acknowledgement?.entryId === critical.id ? acknowledgement.by : null,
        acknowledgedAt: acknowledgement?.entryId === critical.id ? acknowledgement.at : null,
      },
      recent: recent.map(entryOf),
      channels: deliveryChannels,
      // `available` rather than the producer's file path: the console has to
      // show whether a rule can fire at all, and the path is an implementation
      // detail an operator has no use for. See config/alertTypes.js.
      alertTypes: ALERT_TYPES.map(({ producer, ...type }) => ({
        ...type,
        available: !!producer,
        muted: muted.includes(type.key),
      })),
    });
  } catch (err) {
    next(err);
  }
};

// POST /admin/platform-health/acknowledge
//
// Acknowledging is a record that a human has seen the entry, nothing more: it
// dismisses the banner for every operator until a newer critical entry arrives.
// It cannot resolve anything, and the screen does not claim it does.
const acknowledgeCritical = async (req, res, next) => {
  try {
    const { entryId } = req.body || {};
    const entry = entryId ? await AuditLog.findByPk(entryId) : null;
    if (!entry) return res.status(404).json({ error: 'No such log entry' });
    if (levelFor(entry.action) !== 'critical') {
      return res.status(400).json({ error: 'Only a critical entry can be acknowledged' });
    }

    const acknowledgement = {
      entryId: entry.id,
      by: req.user.name || req.user.email,
      at: new Date().toISOString(),
    };
    await setSetting(ACK_KEY, acknowledgement);

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.alert_acknowledged',
      entity: 'AuditLog',
      entityId: entry.id,
      metadata: { action: entry.action },
    });

    res.json({ acknowledgement });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/platform-health/alert-delivery
const updateAlertDelivery = async (req, res, next) => {
  try {
    const { muted } = req.body || {};
    if (!Array.isArray(muted)) return res.status(400).json({ error: 'muted must be an array' });

    const unknown = muted.filter((key) => !ALERT_TYPE_KEYS.includes(key));
    if (unknown.length) return res.status(400).json({ error: `Unknown alert type: ${unknown.join(', ')}` });

    const saved = await setMutedAlertTypes(muted);

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.alert_delivery_updated',
      entity: 'SystemSetting',
      metadata: { muted: saved },
    });

    res.json({ muted: saved });
  } catch (err) {
    next(err);
  }
};

module.exports = { getPlatformHealth, acknowledgeCritical, updateAlertDelivery };
