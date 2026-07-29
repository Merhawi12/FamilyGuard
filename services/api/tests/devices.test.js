const request = require('supertest');
const { app } = require('../src/app');
const { Device, ActivityLog } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

describe('Device linking flow', () => {
  it('generates a code, confirms from the device, and issues a working device token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const gen = await request(app)
      .post('/api/devices/link')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, deviceName: 'Kid Pixel' });
    expect(gen.status).toBe(200);
    expect(gen.body.code).toBeTruthy();

    const confirm = await request(app)
      .post('/api/devices/confirm')
      .send({ code: gen.body.code, deviceId: gen.body.device.id, osVersion: 'Android 14' });
    expect(confirm.status).toBe(200);
    expect(typeof confirm.body.deviceToken).toBe('string');

    // The issued token authenticates device-only routes.
    const rules = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${confirm.body.deviceToken}`);
    expect(rules.status).toBe(200);
    expect(rules.body).toHaveProperty('appRules');
  });

  it('rejects an invalid linking code (404) and a re-link of an already-linked device (400)', async () => {
    const bad = await request(app).post('/api/devices/confirm').send({ code: 'NOPE' });
    expect(bad.status).toBe(404);

    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { linkingCode: 'CODE1234', linkingCodeExpiry: new Date(Date.now() + 60000), isLinked: true });
    const relink = await request(app).post('/api/devices/confirm').send({ code: 'CODE1234', deviceId: device.id });
    expect(relink.status).toBe(400);
  });

  it('forbids removing a device that belongs to another parent (403)', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const device = await createDevice(child.id);

    const attacker = await createUser();
    const res = await request(app)
      .delete(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(res.status).toBe(403);
    const reloaded = await Device.findByPk(device.id);
    expect(reloaded.isActive).toBe(true);
  });
});

describe('Usage-stats ingestion is idempotent per app/day (batch A regression)', () => {
  it('upserts a single row and keeps the max cumulative minutes', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    const post = (durationMinutes) =>
      request(app)
        .post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({ appPackage: 'com.tiktok', appName: 'TikTok', category: 'app_usage', durationMinutes });

    await post(10); // first sync of the day
    await post(25); // later sync — cumulative grew
    await post(20); // a partial/late sync must not shrink the total

    const rows = await ActivityLog.findAll({ where: { childId: child.id, appPackage: 'com.tiktok', category: 'app_usage' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(25);
  });

  it('still appends discrete non-usage events (e.g. web visits)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    const post = () =>
      request(app)
        .post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({ category: 'web', url: 'https://example.com', startTime: new Date().toISOString(), durationMinutes: 1 });

    await post();
    await post();
    const rows = await ActivityLog.findAll({ where: { childId: child.id, category: 'web' } });
    expect(rows.length).toBe(2);
  });
});
