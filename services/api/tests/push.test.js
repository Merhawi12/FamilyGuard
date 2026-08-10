const request = require('supertest');
const { app } = require('../src/app');
const { PushToken, Alert } = require('../src/models');
const { blindIndex } = require('../src/utils/crypto');
const { env } = require('../src/config/env');
const push = require('../src/utils/pushService');
const { createAlert } = require('../src/utils/alertHelper');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

const EXPO_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const webSubscription = (endpoint = 'https://push.example.com/sub/abc') => ({
  endpoint,
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' },
});

/**
 * `PUSH_ENABLED` is false under test by default, so nothing here reaches a real
 * push service unless a test opts in and stubs the transport.
 */
const withPushEnabled = async (fn) => {
  const original = env.push.enabled;
  // env is frozen at the top level, but `push` is a plain nested object.
  env.push.enabled = true;
  try { return await fn(); } finally { env.push.enabled = original; }
};

describe('Push — device token registration', () => {
  it('registers a child device\'s Expo token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await request(app).post('/api/devices/me/push-token')
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ token: EXPO_TOKEN, label: 'Pixel 7' });

    expect(res.status).toBe(201);
    const row = await PushToken.findOne({ where: { deviceId: device.id } });
    expect(row.platform).toBe('expo');
    expect(row.token).toBe(EXPO_TOKEN);
    expect(row.isActive).toBe(true);
  });

  it('stores the token encrypted, with a blind index for lookup', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await request(app).post('/api/devices/me/push-token')
      .set('Authorization', `Bearer ${deviceToken(device)}`).send({ token: EXPO_TOKEN });

    const [raw] = await PushToken.sequelize.query(
      'SELECT token, token_hash FROM push_tokens WHERE device_id = ?',
      { replacements: [device.id], type: PushToken.sequelize.QueryTypes.SELECT },
    );
    expect(raw.token).not.toContain('ExponentPushToken');
    expect(raw.token_hash).toBe(blindIndex(EXPO_TOKEN));
  });

  it('rejects something that is not an Expo token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    for (const bad of ['', 'just-a-string', 'fcm:abc123', null]) {
      const res = await request(app).post('/api/devices/me/push-token')
        .set('Authorization', `Bearer ${deviceToken(device)}`).send({ token: bad });
      expect(res.status).toBe(400);
    }
    expect(await PushToken.count({ where: { deviceId: device.id } })).toBe(0);
  });

  it('re-registering the same token updates one row rather than adding another', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const auth = `Bearer ${deviceToken(device)}`;

    await request(app).post('/api/devices/me/push-token').set('Authorization', auth).send({ token: EXPO_TOKEN });
    await request(app).post('/api/devices/me/push-token').set('Authorization', auth).send({ token: EXPO_TOKEN });
    await request(app).post('/api/devices/me/push-token').set('Authorization', auth).send({ token: EXPO_TOKEN });

    expect(await PushToken.count({ where: { deviceId: device.id } })).toBe(1);
  });

  it('revives a token that had been retired after failures — the reinstall case', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const auth = `Bearer ${deviceToken(device)}`;

    await request(app).post('/api/devices/me/push-token').set('Authorization', auth).send({ token: EXPO_TOKEN });
    const row = await PushToken.findOne({ where: { deviceId: device.id } });
    await row.update({ isActive: false, failureCount: 5, lastError: 'DeviceNotRegistered' });

    await request(app).post('/api/devices/me/push-token').set('Authorization', auth).send({ token: EXPO_TOKEN });

    await row.reload();
    expect(row.isActive).toBe(true);
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it('registers against the calling device, never one named in the body', async () => {
    const parent = await createUser();
    const ada = await createChild(parent.id);
    const ben = await createChild(parent.id);
    const adaDevice = await createDevice(ada.id);
    const benDevice = await createDevice(ben.id);

    await request(app).post('/api/devices/me/push-token')
      .set('Authorization', `Bearer ${deviceToken(adaDevice)}`)
      .send({ token: EXPO_TOKEN, deviceId: benDevice.id });

    expect(await PushToken.count({ where: { deviceId: benDevice.id } })).toBe(0);
    expect(await PushToken.count({ where: { deviceId: adaDevice.id } })).toBe(1);
  });

  it('lets a device remove its own token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const auth = `Bearer ${deviceToken(device)}`;

    await request(app).post('/api/devices/me/push-token').set('Authorization', auth).send({ token: EXPO_TOKEN });
    const res = await request(app).delete('/api/devices/me/push-token').set('Authorization', auth).send({});
    expect(res.status).toBe(200);
    expect(await PushToken.count({ where: { deviceId: device.id } })).toBe(0);
  });

  it('rejects registration without a device token', async () => {
    const parent = await createUser();
    expect((await request(app).post('/api/devices/me/push-token').send({ token: EXPO_TOKEN })).status).toBe(401);
    expect((await request(app).post('/api/devices/me/push-token')
      .set('Authorization', `Bearer ${tokenFor(parent)}`).send({ token: EXPO_TOKEN })).status).toBe(401);
  });
});

describe('Push — parent browser subscriptions', () => {
  it('subscribes a browser and lists it without ever returning the token', async () => {
    const parent = await createUser();
    const auth = `Bearer ${tokenFor(parent)}`;

    const res = await request(app).post('/api/notifications/push/subscribe')
      .set('Authorization', auth).send({ subscription: webSubscription(), label: 'Chrome on Windows' });
    expect(res.status).toBe(201);

    const list = await request(app).get('/api/notifications/push/subscriptions').set('Authorization', auth);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].label).toBe('Chrome on Windows');
    expect(JSON.stringify(list.body)).not.toContain('push.example.com');
  });

  it('rejects a malformed subscription', async () => {
    const parent = await createUser();
    const auth = `Bearer ${tokenFor(parent)}`;

    for (const bad of [{ endpoint: 'https://x' }, { keys: {} }, 'not-json', {}]) {
      const res = await request(app).post('/api/notifications/push/subscribe')
        .set('Authorization', auth).send({ subscription: bad });
      expect(res.status).toBe(400);
    }
    expect(await PushToken.count({ where: { userId: parent.id } })).toBe(0);
  });

  it('reassigns a shared browser to whoever signed in last', async () => {
    const first = await createUser();
    const second = await createUser();
    const subscription = webSubscription('https://push.example.com/shared');

    await request(app).post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(first)}`).send({ subscription });
    await request(app).post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(second)}`).send({ subscription });

    // Scoped to these two accounts: the schema is created once per file, so an
    // unscoped count would also see rows from the tests above.
    expect(await PushToken.count({ where: { tokenHash: blindIndex(JSON.stringify(subscription)) } })).toBe(1);
    expect(await PushToken.count({ where: { userId: first.id } })).toBe(0);
    expect(await PushToken.count({ where: { userId: second.id } })).toBe(1);
  });

  it('unsubscribes only the caller\'s own browser', async () => {
    const owner = await createUser();
    const other = await createUser();
    const subscription = webSubscription('https://push.example.com/owner');

    await request(app).post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(owner)}`).send({ subscription });

    // Another account naming the same endpoint must not be able to remove it.
    const attempt = await request(app).post('/api/notifications/push/unsubscribe')
      .set('Authorization', `Bearer ${tokenFor(other)}`).send({ subscription });
    expect(attempt.body.removed).toBe(0);
    expect(await PushToken.count({ where: { userId: owner.id } })).toBe(1);

    const own = await request(app).post('/api/notifications/push/unsubscribe')
      .set('Authorization', `Bearer ${tokenFor(owner)}`).send({ subscription });
    expect(own.body.removed).toBe(1);
  });

  it('refuses to delete another parent\'s subscription by id', async () => {
    const owner = await createUser();
    const attacker = await createUser();

    const created = await request(app).post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${tokenFor(owner)}`).send({ subscription: webSubscription() });

    const res = await request(app).delete(`/api/notifications/push/subscriptions/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(res.status).toBe(404);
    expect(await PushToken.count({ where: { userId: owner.id } })).toBe(1);
  });

  // See contactSync.test.js for why this matters on Postgres.
  it('treats a malformed subscription id as not found rather than erroring', async () => {
    const parent = await createUser();
    for (const bad of ['not-a-uuid', '7', "' OR 1=1--"]) {
      const res = await request(app)
        .delete(`/api/notifications/push/subscriptions/${encodeURIComponent(bad)}`)
        .set('Authorization', `Bearer ${tokenFor(parent)}`);
      expect(res.status).toBe(404);
    }
  });

  it('reports whether push is configured at all', async () => {
    const parent = await createUser();
    const res = await request(app).get('/api/notifications/push/config')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('available');
    // No VAPID keys in the test environment, so nothing is served to a browser.
    expect(res.body.publicKey).toBe('');
  });

  it('refuses a test send when nothing is subscribed', async () => {
    const parent = await createUser();
    const res = await request(app).post('/api/notifications/push/test')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(400);
  });

  it('requires authentication on every push route', async () => {
    for (const [method, path] of [
      ['get', '/api/notifications/push/config'],
      ['get', '/api/notifications/push/subscriptions'],
      ['post', '/api/notifications/push/subscribe'],
      ['post', '/api/notifications/push/unsubscribe'],
      ['post', '/api/notifications/push/test'],
    ]) {
      expect((await request(app)[method](path).send({})).status).toBe(401);
    }
  });
});

describe('Push — delivery and token health', () => {
  const mockExpo = (response) => {
    global.fetch = jest.fn(async () => ({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    }));
  };

  afterEach(() => { delete global.fetch; jest.restoreAllMocks(); });

  it('sends to a child\'s device and records the success', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await push.registerToken({ token: EXPO_TOKEN, platform: 'expo', deviceId: device.id });

    await withPushEnabled(async () => {
      mockExpo({ body: { data: { status: 'ok', id: 'ticket-1' } } });
      const result = await push.sendToChild(child.id, { title: 'Hi', body: 'Dinner at six' });
      expect(result).toMatchObject({ sent: 1, failed: 0, recipients: 1 });
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ to: EXPO_TOKEN, title: 'Hi', body: 'Dinner at six' });

    const row = await PushToken.findOne({ where: { deviceId: device.id } });
    expect(row.lastSuccessAt).toBeTruthy();
    expect(row.failureCount).toBe(0);
  });

  it('retires a token the push service says is gone', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await push.registerToken({ token: EXPO_TOKEN, platform: 'expo', deviceId: device.id });

    await withPushEnabled(async () => {
      mockExpo({ body: { data: { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } } });
      const result = await push.sendToChild(child.id, { title: 'x', body: 'y' });
      expect(result.failed).toBe(1);
    });

    const row = await PushToken.findOne({ where: { deviceId: device.id } });
    expect(row.isActive).toBe(false);
    expect(row.lastError).toMatch(/not registered/);
  });

  it('keeps a token through transient failures, then retires it', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await push.registerToken({ token: EXPO_TOKEN, platform: 'expo', deviceId: device.id });

    await withPushEnabled(async () => {
      global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });

      await push.sendToChild(child.id, { title: 'x', body: 'y' });
      let row = await PushToken.findOne({ where: { deviceId: device.id } });
      expect(row.isActive).toBe(true);
      expect(row.failureCount).toBe(1);

      await push.sendToChild(child.id, { title: 'x', body: 'y' });
      row = await PushToken.findOne({ where: { deviceId: device.id } });
      expect(row.isActive).toBe(true);

      await push.sendToChild(child.id, { title: 'x', body: 'y' });
      row = await PushToken.findOne({ where: { deviceId: device.id } });
      expect(row.failureCount).toBe(push.MAX_FAILURES);
      expect(row.isActive).toBe(false);
    });
  });

  it('never sends to a retired token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const row = await push.registerToken({ token: EXPO_TOKEN, platform: 'expo', deviceId: device.id });
    await row.update({ isActive: false });

    await withPushEnabled(async () => {
      mockExpo({ body: { data: { status: 'ok' } } });
      const result = await push.sendToChild(child.id, { title: 'x', body: 'y' });
      expect(result.recipients).toBe(0);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never sends one child\'s notification to another child\'s device', async () => {
    const parent = await createUser();
    const ada = await createChild(parent.id);
    const ben = await createChild(parent.id);
    const adaDevice = await createDevice(ada.id);
    await push.registerToken({ token: EXPO_TOKEN, platform: 'expo', deviceId: adaDevice.id });

    await withPushEnabled(async () => {
      mockExpo({ body: { data: { status: 'ok' } } });
      const result = await push.sendToChild(ben.id, { title: 'x', body: 'y' });
      expect(result.recipients).toBe(0);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never sends one parent\'s notification to another parent\'s browser', async () => {
    const first = await createUser();
    const second = await createUser();
    await push.registerToken({ token: JSON.stringify(webSubscription()), platform: 'web', userId: first.id });

    await withPushEnabled(async () => {
      const result = await push.sendToUser(second.id, { title: 'x', body: 'y' });
      expect(result.recipients).toBe(0);
    });
  });
});

describe('Push — wired into the flows that matter', () => {
  const fakeIo = () => ({ to: () => ({ emit: () => {} }) });

  it('pushes an alert to the parent', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    await createAlert(fakeIo(), {
      parentId: parent.id, childId: child.id, type: 'emergency_button',
      message: 'Emergency alert from child', severity: 'high',
    });
    // The push is fired without being awaited, so let the microtask queue drain.
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledWith(parent.id, expect.objectContaining({
      body: 'Emergency alert from child',
      data: expect.objectContaining({ type: 'alert', alertType: 'emergency_button', childId: child.id }),
    }));
    expect(await Alert.count({ where: { parentId: parent.id } })).toBe(1);
    spy.mockRestore();
  });

  it('respects the parent\'s push preference', async () => {
    const parent = await createUser({ notificationPrefs: JSON.stringify({ pushAlerts: false }) });
    const child = await createChild(parent.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 0, failed: 0, recipients: 0 });

    await createAlert(fakeIo(), {
      parentId: parent.id, childId: child.id, type: 'blocked_app_attempt',
      message: 'A blocked app was opened', severity: 'medium',
    });
    await new Promise((r) => setImmediate(r));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('records the alert even when the push fails outright', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const spy = jest.spyOn(push, 'sendToUser').mockRejectedValue(new Error('push service down'));

    const alert = await createAlert(fakeIo(), {
      parentId: parent.id, childId: child.id, type: 'cyberbullying',
      message: 'Possible cyberbullying detected', severity: 'high',
    });
    await new Promise((r) => setImmediate(r));

    expect(alert.id).toBeTruthy();
    expect(await Alert.count({ where: { parentId: parent.id } })).toBe(1);
    spy.mockRestore();
  });

  it('pushes a parent\'s chat message to the child\'s device', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const spy = jest.spyOn(push, 'sendToChild').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    const res = await request(app).post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).send({ text: 'Come home now' });
    expect(res.status).toBe(201);
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledWith(child.id, expect.objectContaining({
      body: 'Come home now',
      data: expect.objectContaining({ type: 'chat', screen: 'Messages' }),
    }));
    spy.mockRestore();
  });
});
