const { PushToken } = require('../models');
const push = require('../utils/pushService');
const { isUuid } = require('../utils/ids');

// GET /api/notifications/push/config — what the client needs to subscribe.
//
// `available` covers the browser: false when the deployment has no VAPID keys,
// which lets the settings screen say "not available" rather than failing at
// subscribe time. `fcmAvailable` is the same question for the Android app, which
// needs no key from here — only to know whether a send would go anywhere.
const getPushConfig = async (req, res) => {
  res.json({
    available: push.webPushAvailable(),
    publicKey: push.getPublicKey(),
    fcmAvailable: push.fcmAvailable(),
  });
};

// POST /api/notifications/push/subscribe — register a parent's browser, or their
// Android app.
//
// Both arrive here because both are the same parent asking to be notified on the
// thing in front of them; only the transport differs. `platform` defaults to
// 'web' so that every browser build already in the field keeps working unchanged.
const subscribe = async (req, res, next) => {
  try {
    const { subscription, label, platform = 'web' } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription is required' });
    if (!['web', 'fcm'].includes(platform)) {
      // 'expo' is deliberately not accepted: a child device registers against
      // its own device token at /api/devices/me/push-token, and letting a parent
      // session create one here would attach a child's device to a user row.
      return res.status(400).json({ error: 'platform must be "web" or "fcm"' });
    }

    const row = await push.registerToken({
      token: typeof subscription === 'string' ? subscription : JSON.stringify(subscription),
      platform,
      userId: req.user.id,
      label: label || req.headers['user-agent']?.slice(0, 120) || null,
    });

    res.status(201).json({ id: row.id, label: row.label, createdAt: row.createdAt });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
};

// POST /api/notifications/push/unsubscribe
const unsubscribe = async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription is required' });

    const removed = await push.revokeToken({
      token: typeof subscription === 'string' ? subscription : JSON.stringify(subscription),
      userId: req.user.id,
    });
    res.json({ removed });
  } catch (err) {
    next(err);
  }
};

// GET /api/notifications/push/subscriptions — the parent's registered browsers.
// The token itself is never returned; it is a credential, and the settings
// screen only needs to name the browsers and say whether each still works.
const listSubscriptions = async (req, res, next) => {
  try {
    const rows = await PushToken.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
    });
    res.json(rows.map((r) => ({
      id: r.id,
      label: r.label,
      isActive: r.isActive,
      failureCount: r.failureCount,
      lastSuccessAt: r.lastSuccessAt,
      createdAt: r.createdAt,
    })));
  } catch (err) {
    next(err);
  }
};

// DELETE /api/notifications/push/subscriptions/:id — remove one by id, for the
// settings screen. Scoped to the caller so one parent cannot delete another's.
const removeSubscription = async (req, res, next) => {
  try {
    // Guarded before the query: Postgres rejects a malformed UUID outright,
    // which would turn "no such subscription" into a 500. See utils/ids.js.
    const removed = isUuid(req.params.id)
      ? await PushToken.destroy({ where: { id: req.params.id, userId: req.user.id } })
      : 0;
    if (!removed) return res.status(404).json({ error: 'Subscription not found' });
    res.json({ message: 'Subscription removed' });
  } catch (err) {
    next(err);
  }
};

// POST /api/notifications/push/test — send the caller a notification, so a
// parent can confirm the whole chain works from their own settings screen.
const sendTest = async (req, res, next) => {
  try {
    const result = await push.sendToUser(req.user.id, {
      title: 'Parentix test notification',
      body: 'Push notifications are working on this device.',
      data: { type: 'test', url: '/dashboard/settings' },
    });

    if (result.recipients === 0) {
      return res.status(400).json({ error: 'No push subscriptions registered for this account' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// POST /api/devices/me/push-token — the child device registers its Expo token.
// The device is identified by its token, so it can only ever register itself.
const registerDeviceToken = async (req, res, next) => {
  try {
    const { token, label } = req.body;
    const row = await push.registerToken({
      token,
      platform: 'expo',
      deviceId: req.deviceId,
      label: label || null,
    });
    res.status(201).json({ id: row.id, registered: true });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
};

// DELETE /api/devices/me/push-token — on sign-out or permission withdrawal.
const removeDeviceToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    const removed = token
      ? await push.revokeToken({ token, deviceId: req.deviceId })
      : await PushToken.destroy({ where: { deviceId: req.deviceId } });
    res.json({ removed });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPushConfig,
  subscribe,
  unsubscribe,
  listSubscriptions,
  removeSubscription,
  sendTest,
  registerDeviceToken,
  removeDeviceToken,
};
