/**
 * Firebase Cloud Messaging — the transport that reaches the parent's Android app.
 *
 * It exists because the Android wrapper is a WebView and WebView does not
 * implement the Push API: `PushManager` is absent, so the VAPID transport that
 * serves every browser cannot reach that app at all. Before this, a parent who
 * installed the Android app got no notification ever, and the settings screen
 * told them their browser did not support them.
 *
 * Kept apart from push.test.js because FCM needs google-auth-library mocked for
 * its access token, and that mock would apply to every other test in the file.
 */
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'ya29.test-access-token' }) }),
  })),
  OAuth2Client: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { PushToken } = require('../src/models');
const { env } = require('../src/config/env');
const push = require('../src/utils/pushService');
const { createUser, tokenFor } = require('./helpers');

const FCM_TOKEN = 'fZ1x_TestRegistrationToken:APA91bH-not-a-real-token-0123456789';
const PROJECT = 'parentix-test';

/** An FCM v1 error, shaped as Google returns one. */
const fcmError = (status, errorCode, code = 400) => ({
  ok: false,
  status: code,
  json: async () => ({
    error: {
      code,
      status,
      message: `mock ${errorCode}`,
      details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }],
    },
  }),
});

const fcmOk = () => ({ ok: true, status: 200, json: async () => ({ name: 'projects/p/messages/1' }) });

let originalEnabled;
let originalProject;

beforeEach(() => {
  originalEnabled = env.push.enabled;
  originalProject = env.push.fcmProjectId;
  // env is frozen at the top level, but `push` is a plain nested object.
  env.push.enabled = true;
  env.push.fcmProjectId = PROJECT;
  global.fetch = jest.fn(async () => fcmOk());
});

afterEach(() => {
  env.push.enabled = originalEnabled;
  env.push.fcmProjectId = originalProject;
  delete global.fetch;
  jest.restoreAllMocks();
});

const subscribe = (token, body) =>
  request(app).post('/api/notifications/push/subscribe')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describe('registering the Android app', () => {
  it('accepts an FCM token from a signed-in parent', async () => {
    const parent = await createUser();

    const res = await subscribe(tokenFor(parent), {
      subscription: FCM_TOKEN,
      platform: 'fcm',
      label: 'Parentix app on Pixel 8',
    });

    expect(res.status).toBe(201);
    const row = await PushToken.findOne({ where: { userId: parent.id } });
    expect(row.platform).toBe('fcm');
    expect(row.token).toBe(FCM_TOKEN);
  });

  it('still defaults to a browser subscription when no platform is given', async () => {
    const parent = await createUser();

    // Every browser build already in the field posts exactly this shape.
    await subscribe(tokenFor(parent), {
      subscription: {
        endpoint: 'https://push.example.com/sub/abc',
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' },
      },
    });

    const row = await PushToken.findOne({ where: { userId: parent.id } });
    expect(row.platform).toBe('web');
  });

  /**
   * The pair worth catching. An Expo token sent as 'fcm' would be rejected three
   * times by Google and then retired — a working child device silently
   * unsubscribed by a client bug.
   */
  it('refuses an Expo token registered as FCM', async () => {
    const parent = await createUser();

    const res = await subscribe(tokenFor(parent), {
      subscription: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      platform: 'fcm',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expo/i);
  });

  /**
   * A child device registers against its own device token at
   * /api/devices/me/push-token. Accepting 'expo' here would let a parent session
   * create a row that pretends to be a child's device.
   */
  it('refuses to create an Expo registration from a parent session', async () => {
    const parent = await createUser();

    const res = await subscribe(tokenFor(parent), {
      subscription: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      platform: 'expo',
    });

    expect(res.status).toBe(400);
    expect(await PushToken.count({ where: { userId: parent.id } })).toBe(0);
  });

  it('reports FCM availability so the app can say why nothing arrives', async () => {
    const parent = await createUser();

    const res = await request(app).get('/api/notifications/push/config')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.body.fcmAvailable).toBe(true);

    env.push.fcmProjectId = '';
    const off = await request(app).get('/api/notifications/push/config')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(off.body.fcmAvailable).toBe(false);
  });
});

describe('sending', () => {
  const withFcmToken = async () => {
    const parent = await createUser();
    await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });
    return parent;
  };

  it('posts to the project\'s FCM endpoint with the token and the alert', async () => {
    const parent = await withFcmToken();

    const result = await push.sendToUser(parent.id, {
      title: 'Alert', body: 'Something happened', data: { type: 'alert', url: '/alerts' },
    });

    expect(result.sent).toBe(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`);
    expect(options.headers.Authorization).toBe('Bearer ya29.test-access-token');

    const { message } = JSON.parse(options.body);
    expect(message.token).toBe(FCM_TOKEN);
    expect(message.notification).toEqual({ title: 'Alert', body: 'Something happened' });
    expect(message.android.notification.channel_id).toBe('parentix-alerts');
  });

  /**
   * FCM rejects a data payload with a non-string value, as a 400 — which this
   * code would otherwise read as a dead token and retire. A caller passing a
   * number must not cost a parent their subscription.
   */
  it('stringifies data values rather than letting FCM reject them', async () => {
    const parent = await withFcmToken();

    await push.sendToUser(parent.id, {
      title: 'Alert', body: 'x', data: { unread: 3, childId: 'abc', muted: false, missing: null },
    });

    const { message } = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(message.data).toEqual({ unread: '3', childId: 'abc', muted: 'false' });
    Object.values(message.data).forEach((v) => expect(typeof v).toBe('string'));
  });

  it('retires a token FCM says is no longer registered', async () => {
    const parent = await withFcmToken();
    global.fetch = jest.fn(async () => fcmError('NOT_FOUND', 'UNREGISTERED', 404));

    await push.sendToUser(parent.id, { title: 'x', body: 'y' });

    const row = await PushToken.findOne({ where: { userId: parent.id } });
    expect(row.isActive).toBe(false);
  });

  /**
   * The distinction that stops one bad afternoon at Google from unsubscribing an
   * entire user base.
   */
  it('keeps a token through a transient failure, then retires it', async () => {
    const parent = await withFcmToken();
    global.fetch = jest.fn(async () => fcmError('UNAVAILABLE', 'UNAVAILABLE', 503));

    await push.sendToUser(parent.id, { title: 'x', body: 'y' });
    let row = await PushToken.findOne({ where: { userId: parent.id } });
    expect(row.isActive).toBe(true);
    expect(row.failureCount).toBe(1);

    await push.sendToUser(parent.id, { title: 'x', body: 'y' });
    await push.sendToUser(parent.id, { title: 'x', body: 'y' });
    row = await PushToken.findOne({ where: { userId: parent.id } });
    expect(row.failureCount).toBe(push.MAX_FAILURES);
    expect(row.isActive).toBe(false);
  });

  it('does not reach FCM when the deployment has no project configured', async () => {
    const parent = await withFcmToken();
    env.push.fcmProjectId = '';

    const result = await push.sendToUser(parent.id, { title: 'x', body: 'y' });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    // Skipped, not failed: the token is fine, the deployment is not configured.
    const row = await PushToken.findOne({ where: { userId: parent.id } });
    expect(row.isActive).toBe(true);
    expect(row.failureCount).toBe(0);
  });

  /**
   * One parent, a desktop browser and the Android app. Each row has to go to its
   * own service — the whole point of keeping the platform on the row.
   */
  it('sends to a browser and the app in the same fan-out, each by its own transport', async () => {
    const parent = await createUser();
    await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });
    await push.registerToken({
      token: JSON.stringify({
        endpoint: 'https://push.example.com/sub/abc',
        keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' },
      }),
      platform: 'web',
      userId: parent.id,
    });

    const result = await push.sendToUser(parent.id, { title: 'x', body: 'y' });

    expect(result.recipients).toBe(2);
    // Web Push goes through the web-push library, not fetch, and has no VAPID
    // keys under test — so exactly one call reaches FCM and the browser row is
    // handled elsewhere.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('fcm.googleapis.com');
  });
});

/**
 * Re-registration corrupted the stored token.
 *
 * `registerToken` updates the existing row rather than adding a second one when
 * a token comes back — which is the normal case, not the exception: a browser
 * hands back the same subscription on every load and `resyncPush()` re-registers
 * on every sign-in. That update validated twice, and the encryption hook ran on
 * both passes, so the row ended up holding the ciphertext of its own ciphertext.
 *
 * Nothing about that was visible until a send: the value read back was base64
 * rather than a token, Web Push could not parse it, and an unparseable
 * subscription is treated as permanently dead and retired. A parent lost
 * notifications for good on their second sign-in.
 *
 * These live here rather than in push.test.js because that file's fetch stub
 * answers every send identically, which is exactly what hid this.
 */
describe('re-registering a token does not corrupt it', () => {
  const readBack = async (where) => (await PushToken.findAll({ where }))[0].token;

  it('keeps an FCM token usable after re-registration', async () => {
    const parent = await createUser();
    await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });
    await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });

    expect(await readBack({ userId: parent.id })).toBe(FCM_TOKEN);
  });

  it('keeps a browser subscription parseable after a second sign-in', async () => {
    const parent = await createUser();
    const subscription = JSON.stringify({
      endpoint: 'https://push.example.com/sub/resync',
      keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' },
    });

    await push.registerToken({ token: subscription, platform: 'web', userId: parent.id });
    await push.registerToken({ token: subscription, platform: 'web', userId: parent.id });

    const stored = await readBack({ userId: parent.id });
    // The exact operation sendWeb performs, and the one that used to throw and
    // retire the subscription outright.
    expect(() => JSON.parse(stored)).not.toThrow();
    expect(JSON.parse(stored).endpoint).toBe('https://push.example.com/sub/resync');
  });

  it('survives repeated re-registration, not just one round', async () => {
    const parent = await createUser();
    for (let i = 0; i < 4; i += 1) {
      await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });
    }

    expect(await readBack({ userId: parent.id })).toBe(FCM_TOKEN);
    // Still one row, which is the other half of what re-registration promises.
    expect(await PushToken.count({ where: { userId: parent.id } })).toBe(1);
  });

  it('still delivers to a token that has been re-registered', async () => {
    const parent = await createUser();
    await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });
    await push.registerToken({ token: FCM_TOKEN, platform: 'fcm', userId: parent.id });

    const result = await push.sendToUser(parent.id, { title: 'x', body: 'y' });

    expect(result.sent).toBe(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).message.token).toBe(FCM_TOKEN);
  });
});
