const webpush = require('web-push');
const { GoogleAuth } = require('google-auth-library');
const { Op } = require('sequelize');
const { PushToken, Device } = require('../models');
const { blindIndex } = require('../utils/crypto');
const { env } = require('../config/env');
const logger = require('./logger');

/**
 * Delivery to a recipient's own device, for when the app is not open.
 *
 * Three transports, one interface. Callers say who to notify, not how:
 *
 *   web    A parent with the dashboard open in a browser — Web Push, VAPID.
 *   fcm    A parent running the Android app — Firebase Cloud Messaging. The
 *          Android wrapper is a WebView, and WebView does not implement the
 *          Push API, so `PushManager` is simply absent there and the browser
 *          transport cannot reach it. This is the only way that app is notified.
 *   expo   A child device. Expo's own relay, which itself hands off to FCM.
 *
 * Everything here is best-effort by design. A push that fails must never fail
 * the request that triggered it — the alert is already recorded in the database
 * and pushed over the socket, and the notification is the redundant copy. What
 * this does guarantee is that every attempt and every failure is logged, and
 * that a token the push service rejects is retired rather than retried forever.
 */

/** Consecutive failures before a token is treated as dead. */
const MAX_FAILURES = 3;

const PLATFORMS = ['web', 'fcm', 'expo'];

let vapidConfigured = false;

const webPushAvailable = () => {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = env.push;
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    vapidConfigured = true;
  }
  return true;
};

/** What the client needs to subscribe. Empty when push is not configured. */
const getPublicKey = () => (webPushAvailable() ? env.push.vapidPublicKey : '');

/**
 * FCM needs a project to send on behalf of and credentials to prove it may.
 *
 * On Cloud Run both come for free: the project is in the environment and the
 * service account is the Application Default Credential, so there is no key file
 * and no secret to rotate — the `roles/firebasecloudmessaging.admin` grant in iam.tf
 * is the whole of the authorisation. Off the platform there are no default
 * credentials, so this reports unavailable and the transport is skipped rather
 * than failing once per notification.
 */
const fcmAvailable = () => Boolean(env.push.fcmProjectId);

const isExpoToken = (token) => /^Expo(nent)?PushToken\[.+\]$/.test(String(token || '').trim());

// ── Recording outcomes ────────────────────────────────────────────────────────

const recordSuccess = (row) =>
  row.update({ failureCount: 0, lastError: null, lastSuccessAt: new Date() }).catch(() => {});

/**
 * A token that the push service says is gone is retired immediately; anything
 * else is counted, and only retired once it has failed repeatedly. That
 * distinction is what stops one bad afternoon on a push service from
 * unsubscribing an entire user base.
 */
const recordFailure = (row, message, permanent) => {
  const failureCount = (row.failureCount || 0) + 1;
  const retire = permanent || failureCount >= MAX_FAILURES;

  logger.warn('push delivery failed', {
    pushTokenId: row.id,
    platform: row.platform,
    userId: row.userId || undefined,
    deviceId: row.deviceId || undefined,
    error: message,
    permanent: !!permanent,
    retired: retire,
  });

  return row.update({
    failureCount,
    lastError: String(message).slice(0, 250),
    ...(retire && { isActive: false }),
  }).catch(() => {});
};

// ── Transports ────────────────────────────────────────────────────────────────

const sendWeb = async (row, payload) => {
  if (!webPushAvailable()) return { ok: false, skipped: 'web push not configured' };

  let subscription;
  try {
    subscription = JSON.parse(row.token);
  } catch {
    // Unparseable is permanent: it will never become valid on a retry.
    await recordFailure(row, 'stored subscription is not valid JSON', true);
    return { ok: false, error: 'invalid subscription' };
  }

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    await recordSuccess(row);
    return { ok: true };
  } catch (err) {
    // 404/410 is the push service saying the subscription no longer exists.
    const permanent = err.statusCode === 404 || err.statusCode === 410;
    await recordFailure(row, err.body || err.message, permanent);
    return { ok: false, error: err.message };
  }
};

/**
 * FCM HTTP v1, reached directly rather than through firebase-admin.
 *
 * The SDK would add some 50 MB to the image to wrap one authenticated POST, and
 * google-auth-library is already a dependency for verifying Google sign-in
 * tokens — so the access token comes from the same place, and the send looks
 * like the Expo one next to it.
 *
 * The client is built once and cached: it holds the access token and refreshes
 * it as needed, and constructing a new one per notification would fetch a fresh
 * token every time.
 */
let fcmAuth = null;

const fcmAccessToken = async () => {
  fcmAuth = fcmAuth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  const client = await fcmAuth.getClient();
  const { token } = await client.getAccessToken();
  return token;
};

/**
 * FCM rejects a data payload whose values are not all strings, and does so with
 * a 400 that this code would then treat as a dead token and retire. Coercing
 * here keeps a caller passing `{ childId, unread: 3 }` from unsubscribing a
 * perfectly good device.
 */
const fcmData = (data = {}) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
  );

/** Errors FCM names as final. Anything else may be a bad minute at Google. */
const FCM_PERMANENT = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

const sendFcm = async (row, payload) => {
  if (!fcmAvailable()) return { ok: false, skipped: 'FCM not configured' };

  const message = {
    message: {
      token: row.token,
      notification: { title: payload.title, body: payload.body },
      data: fcmData(payload.data),
      android: {
        priority: 'HIGH',
        notification: {
          // Must match the channel the app creates on first run. A message
          // naming a channel that does not exist is dropped by Android without
          // an error to either side.
          channel_id: 'parentix-alerts',
          default_sound: true,
        },
      },
    },
  };

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.push.fcmProjectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await fcmAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      }
    );

    if (res.ok) {
      await recordSuccess(row);
      return { ok: true };
    }

    const body = await res.json().catch(() => null);
    // The specific reason lives in details[], not in the top-level status: a
    // retired token comes back as 404 NOT_FOUND with errorCode UNREGISTERED.
    const errorCode =
      body?.error?.details?.find((d) => d.errorCode)?.errorCode ||
      (res.status === 404 ? 'UNREGISTERED' : body?.error?.status) ||
      `HTTP ${res.status}`;

    await recordFailure(row, body?.error?.message || errorCode, FCM_PERMANENT.has(errorCode));
    return { ok: false, error: errorCode };
  } catch (err) {
    // Network trouble, or no default credentials to sign with. Neither says
    // anything about the token, so it is counted rather than retired.
    await recordFailure(row, err.message, false);
    return { ok: false, error: err.message };
  }
};

const sendExpo = async (row, payload) => {
  const message = {
    to: row.token,
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    sound: 'default',
    priority: 'high',
    channelId: 'parentix-alerts',
  };

  try {
    const res = await fetch(env.push.expoEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(env.push.expoAccessToken && { Authorization: `Bearer ${env.push.expoAccessToken}` }),
      },
      body: JSON.stringify(message),
    });

    const body = await res.json().catch(() => null);
    const ticket = Array.isArray(body?.data) ? body.data[0] : body?.data;

    if (!res.ok) {
      await recordFailure(row, `Expo responded ${res.status}`, res.status === 400);
      return { ok: false, error: `HTTP ${res.status}` };
    }

    if (ticket?.status === 'error') {
      // Expo names an uninstalled or reinstalled app explicitly; anything else
      // may be transient.
      const permanent = ticket.details?.error === 'DeviceNotRegistered';
      await recordFailure(row, ticket.message || 'Expo rejected the message', permanent);
      return { ok: false, error: ticket.message };
    }

    await recordSuccess(row);
    return { ok: true };
  } catch (err) {
    await recordFailure(row, err.message, false);
    return { ok: false, error: err.message };
  }
};

// ── Sending ───────────────────────────────────────────────────────────────────

const deliver = async (rows, payload, context) => {
  if (rows.length === 0) {
    /**
     * Nowhere to send it, said out loud.
     *
     * This returned silently, which made the two ways a notification fails to
     * arrive indistinguishable in the logs: a send that failed leaves a `push
     * delivery failed` line, and a send with no destination left nothing at all.
     * So "the parent never got the emergency alert" and "the parent has never
     * turned notifications on" looked the same from the outside — and the second
     * is the commoner of the two and the one an operator can actually act on.
     *
     * `info`, not `warn`: an account with no push subscription is an ordinary
     * state, not a fault. What matters is that the attempt is on the record.
     */
    logger.info('push had no active destination', { ...context, recipients: 0 });
    return { sent: 0, failed: 0, recipients: 0 };
  }

  if (!env.push.enabled) {
    // Tests and local runs: record the intent without reaching a push service,
    // so the surrounding flow is still exercised end to end.
    logger.info('push suppressed (PUSH_ENABLED=false)', { ...context, recipients: rows.length });
    return { sent: 0, failed: 0, recipients: rows.length, suppressed: true };
  }

  const transport = { web: sendWeb, fcm: sendFcm, expo: sendExpo };
  const results = await Promise.all(
    // An unrecognised platform falls to Expo, which is where every row landed
    // before FCM existed and what the child app still registers as.
    rows.map((row) => (transport[row.platform] || sendExpo)(row, payload))
  );

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;

  logger.info('push dispatched', { ...context, recipients: rows.length, sent, failed });
  return { sent, failed, recipients: rows.length };
};

/** Notify a parent on every browser they have subscribed. */
const sendToUser = async (userId, payload) => {
  if (!userId) return { sent: 0, failed: 0, recipients: 0 };
  const rows = await PushToken.findAll({ where: { userId, isActive: true } });
  return deliver(rows, payload, { target: 'user', userId, type: payload.data?.type });
};

/** Notify every active device belonging to one child. */
const sendToChild = async (childId, payload) => {
  if (!childId) return { sent: 0, failed: 0, recipients: 0 };
  const devices = await Device.findAll({
    where: { childId, isActive: true },
    attributes: ['id'],
  });
  if (devices.length === 0) return { sent: 0, failed: 0, recipients: 0 };

  const rows = await PushToken.findAll({
    where: { deviceId: { [Op.in]: devices.map((d) => d.id) }, isActive: true },
  });
  return deliver(rows, payload, { target: 'child', childId, type: payload.data?.type });
};

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Store a push destination, or revive the row that already holds it.
 *
 * Re-registration is the normal case, not the exception: a browser hands back
 * the same subscription on every load, and a reinstalled app re-registers on
 * first run. Matching on the token's blind index means those update one row
 * instead of accumulating a new one — and a token that had been retired after
 * failures comes back with its counters cleared, which is what makes
 * reinstalling the app fix push for that device.
 */
const registerToken = async ({ token, platform, userId = null, deviceId = null, label = null }) => {
  const value = String(token || '').trim();
  if (!value) throw Object.assign(new Error('token is required'), { status: 400 });
  if (!PLATFORMS.includes(platform)) {
    throw Object.assign(new Error(`platform must be one of ${PLATFORMS.join(', ')}`), { status: 400 });
  }
  if (platform === 'expo' && !isExpoToken(value)) {
    throw Object.assign(new Error('Not a valid Expo push token'), { status: 400 });
  }
  /**
   * An FCM registration token has no documented format to validate against, so
   * the only check worth making is that an Expo token has not been sent under
   * the wrong platform. Getting that pair the wrong way round would otherwise
   * fail three times against FCM and retire a working token.
   */
  if (platform === 'fcm' && isExpoToken(value)) {
    throw Object.assign(new Error('That is an Expo push token — register it as platform "expo"'), { status: 400 });
  }
  if (platform === 'web') {
    let parsed;
    try { parsed = JSON.parse(value); } catch { parsed = null; }
    if (!parsed?.endpoint || !parsed?.keys?.p256dh || !parsed?.keys?.auth) {
      throw Object.assign(new Error('Not a valid Web Push subscription'), { status: 400 });
    }
  }

  const existing = await PushToken.findOne({ where: { tokenHash: blindIndex(value) } });
  if (existing) {
    // The same token can move between owners — a parent signing in on a shared
    // browser, or a device relinked to a different child — so ownership is
    // reassigned rather than left pointing at whoever registered it first.
    await existing.update({
      userId, deviceId, platform, label: label || existing.label,
      isActive: true, failureCount: 0, lastError: null,
      token: value,
    });
    return existing;
  }

  return PushToken.create({ token: value, platform, userId, deviceId, label });
};

const revokeToken = async ({ token, userId = null, deviceId = null }) => {
  const value = String(token || '').trim();
  if (!value) return 0;

  // Scoped to the caller so one account cannot unsubscribe another's browser.
  const where = { tokenHash: blindIndex(value) };
  if (userId) where.userId = userId;
  if (deviceId) where.deviceId = deviceId;

  return PushToken.destroy({ where });
};

module.exports = {
  sendToUser,
  sendToChild,
  registerToken,
  revokeToken,
  getPublicKey,
  webPushAvailable,
  fcmAvailable,
  isExpoToken,
  PLATFORMS,
  MAX_FAILURES,
};
