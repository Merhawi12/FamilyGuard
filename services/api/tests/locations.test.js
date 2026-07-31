const request = require('supertest');
const { app } = require('../src/app');
const { Location } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const premium = () => createUser({ plan: 'premium' });

/**
 * Two ways a position reaches the API, with different authorisation:
 *
 * - `POST /api/locations` is the device reporting itself. Identity comes from
 *   the device token so a phone can never write another child's position.
 * - `POST /api/locations/:childId/manual` is the parent setting one by hand
 *   from the dashboard. A parent holds no device token, so it authorises on
 *   ownership of the child instead.
 *
 * The dashboard used to post to the device route with the parent's session
 * token. That always 401'd, and because the shared axios client treats a 401 as
 * a dead session it signed the parent out — so these cover the parent path.
 */
describe('parent-set locations', () => {
  it('records a position for the parent\'s own child', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ latitude: 45.42, longitude: -75.7, accuracy: 10, address: '1 Main St' });

    expect(res.status).toBe(201);
    expect(res.body.childId).toBe(child.id);
    expect(res.body.deviceId).toBe(device.id);
    expect(Number(res.body.latitude)).toBeCloseTo(45.42);
    expect(res.body.address).toBe('1 Main St');
  });

  it('is readable straight back as the current location', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    await createDevice(child.id);
    const token = tokenFor(parent);

    await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: 10.5, longitude: 20.25 });

    const res = await request(app)
      .get(`/api/locations/${child.id}/current`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.latitude)).toBeCloseTo(10.5);
  });

  it('rejects a position for someone else\'s child', async () => {
    const [owner, stranger] = [await premium(), await premium()];
    const child = await createChild(owner.id);
    await createDevice(child.id);

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)
      .send({ latitude: 1, longitude: 2 });

    expect(res.status).toBe(404);
    expect(await Location.count({ where: { childId: child.id } })).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .send({ latitude: 1, longitude: 2 });

    expect(res.status).toBe(401);
  });

  it('requires latitude and longitude', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ address: 'nowhere in particular' });

    expect(res.status).toBe(400);
  });

  it('explains that a device has to be linked first', async () => {
    const parent = await premium();
    const child = await createChild(parent.id); // no device

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ latitude: 1, longitude: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/link a device/i);
  });

  it('does not mark the device as seen — the parent typed this, the phone said nothing', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { lastSeen: null });

    await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ latitude: 1, longitude: 2 });

    await device.reload();
    expect(device.lastSeen).toBeNull();
  });

  it('is gated on the gps_tracking entitlement once the trial lapses', async () => {
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() - DAY) });
    const child = await createChild(parent.id);
    await createDevice(child.id);

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ latitude: 1, longitude: 2 });

    expect(res.status).toBe(403);
    expect(res.body.upgradeRequired).toBe(true);
  });
});

describe('device-reported locations', () => {
  it('still records against the identity in the device token', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ latitude: 5, longitude: 6, accuracy: 8 });

    expect(res.status).toBe(201);
    expect(res.body.childId).toBe(child.id);
    expect(res.body.deviceId).toBe(device.id);
  });

  it('ignores a childId in the body — the token decides', async () => {
    const [owner, victimParent] = [await premium(), await premium()];
    const child = await createChild(owner.id);
    const device = await createDevice(child.id);
    const victimChild = await createChild(victimParent.id);

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ childId: victimChild.id, deviceId: device.id, latitude: 7, longitude: 8 });

    expect(res.status).toBe(201);
    expect(res.body.childId).toBe(child.id);
    expect(await Location.count({ where: { childId: victimChild.id } })).toBe(0);
  });

  it('refuses a parent session token', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, latitude: 1, longitude: 2 });

    expect(res.status).toBe(401);
  });

  it('marks the device as seen', async () => {
    const parent = await premium();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { lastSeen: null });

    await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ latitude: 1, longitude: 2 });

    await device.reload();
    expect(device.lastSeen).not.toBeNull();
  });
});
