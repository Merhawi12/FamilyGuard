/**
 * A fix that cannot be plotted must be refused at the door.
 *
 * The endpoint used to accept anything non-null: `"abc"` became NaN, `999` a
 * latitude that cannot exist, `true` a 1. NaN is the dangerous one — it
 * serialises to `null` so the map plots nothing, and every comparison against it
 * is false, so the geofence check silently stops raising enter/leave alerts.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { Location, SafeZone } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

const premiumParent = () => createUser({ plan: 'premium', subscriptionStatus: 'active' });

describe('POST /api/locations — coordinate validation', () => {
  let tok;
  let child;

  beforeEach(async () => {
    const parent = await createUser();
    child = await createChild(parent.id);
    tok = deviceToken(await createDevice(child.id));
  });

  const post = (body) => request(app).post('/api/locations').set('Authorization', `Bearer ${tok}`).send(body);

  it.each([
    ['a non-numeric string', { latitude: 'abc', longitude: 10 }],
    ['a latitude beyond the pole', { latitude: 999, longitude: 10 }],
    ['a longitude past the date line', { latitude: 10, longitude: -5000 }],
    ['an object and an array', { latitude: {}, longitude: [] }],
    ['booleans', { latitude: true, longitude: false }],
    ['blank strings', { latitude: '', longitude: '' }],
    ['a missing longitude', { latitude: 45 }],
    ['nothing at all', {}],
  ])('rejects %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await Location.count({ where: { childId: child.id } })).toBe(0);
  });

  it('accepts a genuine fix, including null island and the extremes', async () => {
    for (const body of [
      { latitude: 0, longitude: 0 },
      { latitude: 90, longitude: 180 },
      { latitude: -90, longitude: -180 },
      { latitude: 45.4215, longitude: -75.6972, accuracy: 12.5, speed: 1.2, heading: 270 },
    ]) {
      expect((await post(body)).status).toBe(201);
    }
    expect(await Location.count({ where: { childId: child.id } })).toBe(4);
  });

  it('accepts numeric strings, which is what some clients send', async () => {
    const res = await post({ latitude: '45.4215', longitude: '-75.6972' });
    expect(res.status).toBe(201);
    expect(res.body.latitude).toBeCloseTo(45.4215, 4);
  });

  it('drops an unusable accuracy instead of storing NaN beside a good fix', async () => {
    const res = await post({ latitude: 45, longitude: -75, accuracy: 'very' });
    expect(res.status).toBe(201);
    expect(res.body.accuracy).toBeNull();
  });

  it('keeps the geofence working, which NaN silently disabled', async () => {
    const parent = await premiumParent();
    const kid = await createChild(parent.id);
    const device = await createDevice(kid.id);
    await SafeZone.create({
      parentId: parent.id, childId: kid.id, name: 'Home',
      latitude: 45, longitude: -75, radiusMeters: 500, isActive: true,
    });

    const devTok = deviceToken(device);
    const send = (body) => request(app).post('/api/locations').set('Authorization', `Bearer ${devTok}`).send(body);

    // Inside the zone, then far outside it — the transition must be detectable.
    expect((await send({ latitude: 45, longitude: -75 })).status).toBe(201);
    expect((await send({ latitude: 46.5, longitude: -75 })).status).toBe(201);

    const alerts = await require('../src/models').Alert.findAll({ where: { childId: kid.id } });
    expect(alerts.map((a) => a.type)).toContain('left_safe_zone');
  });
});

describe('POST /api/locations/:childId/manual — coordinate validation', () => {
  it('refuses a position the map could not plot', async () => {
    const parent = await premiumParent();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    const res = await request(app).post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ latitude: 12345, longitude: 'east' });

    expect(res.status).toBe(400);
  });

  it('accepts a real one', async () => {
    const parent = await premiumParent();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    const res = await request(app).post(`/api/locations/${child.id}/manual`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ latitude: 45.4215, longitude: -75.6972, address: 'Ottawa' });

    expect(res.status).toBe(201);
    expect(res.body.address).toBe('Ottawa');
    // A typed position says nothing about motion.
    expect(res.body.speed).toBeNull();
  });
});
