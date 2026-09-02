const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, httpServer, io } = require('../src/app');
const { ScreenTimeRule } = require('../src/models');
const {
  createUser, tokenFor, createChild, createDevice, deviceToken,
} = require('./helpers');

/**
 * Who a screen-time change is pushed to, and — the part that was wrong — who it
 * is not.
 *
 * Both agents apply this event's payload straight onto their cached
 * `screenTimeRule`; neither looks at whose scope it names, and neither can,
 * because the payload for "this device's exception was cleared" and the payload
 * for "the child's shared rule changed" are the same shape. So the routing has
 * to be right on this side.
 *
 * A device joins `child:<id>` *and* `device:<id>` at authentication, which is
 * what made the child-wide broadcast reach a device that had its own exception.
 */

let baseUrl;
const openClients = [];

const connect = (auth) => new Promise((resolve, reject) => {
  const socket = Client(baseUrl, {
    auth, transports: ['websocket'], forceNew: true, reconnection: false,
  });
  openClients.push(socket);
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', (err) => reject(err));
});

const waitForEvent = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});

const expectNoEvent = (socket, event, ms = 600) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event); resolve(true); }, ms);
  socket.once(event, () => { clearTimeout(timer); resolve(false); });
});

/** A parent, one child, and two of the child's devices. */
const family = async () => {
  const parent = await createUser();
  const child = await createChild(parent.id);
  const phone = await createDevice(child.id, { name: 'Phone' });
  const laptop = await createDevice(child.id, { name: 'Laptop', type: 'windows' });
  return { parent, child, phone, laptop, token: tokenFor(parent) };
};

const putRule = (f, body, deviceId) =>
  request(app)
    .put(`/api/screen-time/${f.child.id}${deviceId ? `?deviceId=${deviceId}` : ''}`)
    .set('Authorization', `Bearer ${f.token}`)
    .send(body);

beforeAll((done) => {
  httpServer.listen(0, () => {
    baseUrl = `http://localhost:${httpServer.address().port}`;
    done();
  });
});

afterEach(() => {
  while (openClients.length) openClients.pop().disconnect();
});

afterAll((done) => { io.close(() => done()); });

describe('Editing the child-wide screen time rule', () => {
  it('reaches a device that has no exception of its own', async () => {
    const f = await family();
    const phone = await connect({ token: deviceToken(f.phone) });

    const seen = waitForEvent(phone, 'screen_time_updated');
    const res = await putRule(f, { dailyLimitMinutes: 60 });
    expect(res.status).toBe(200);

    const rule = await seen;
    expect(rule.dailyLimitMinutes).toBe(60);
    expect(rule.deviceId).toBeNull();
  });

  /**
   * The bug this file was written for.
   *
   * The laptop has been given three hours of its own. The parent then edits the
   * child's shared rule down to one — a change that, by the override rule in
   * utils/deviceScope.js, the laptop is not governed by at all. It was being
   * handed that hour anyway, and `rules.js` on both agents assigns it without
   * question, so the laptop locked at the child-wide limit until the next
   * five-minute poll quietly put the exception back.
   */
  it('does not reach a device the parent has given its own rule', async () => {
    const f = await family();
    // Creating the exception is a write against the device scope.
    await putRule(f, { dailyLimitMinutes: 180 }, f.laptop.id);

    const laptop = await connect({ token: deviceToken(f.laptop) });
    const phone = await connect({ token: deviceToken(f.phone) });

    const quiet = expectNoEvent(laptop, 'screen_time_updated');
    const heard = waitForEvent(phone, 'screen_time_updated');
    await putRule(f, { dailyLimitMinutes: 60 });

    // The sibling with no exception still gets it — the narrowing must not turn
    // the child-wide push off for everyone.
    expect((await heard).dailyLimitMinutes).toBe(60);
    expect(await quiet).toBe(true);

    // And the laptop's own rule is untouched, so the poll it would have been
    // corrected by has nothing to correct.
    const own = await ScreenTimeRule.findOne({
      where: { childId: f.child.id, deviceId: f.laptop.id },
    });
    expect(own.dailyLimitMinutes).toBe(180);
  });
});

describe('Editing one device rule', () => {
  it('reaches that device and not its sibling', async () => {
    const f = await family();
    const laptop = await connect({ token: deviceToken(f.laptop) });
    const phone = await connect({ token: deviceToken(f.phone) });

    const heard = waitForEvent(laptop, 'screen_time_updated');
    const quiet = expectNoEvent(phone, 'screen_time_updated');
    await putRule(f, { dailyLimitMinutes: 180 }, f.laptop.id);

    const rule = await heard;
    expect(rule.dailyLimitMinutes).toBe(180);
    expect(rule.deviceId).toBe(f.laptop.id);
    expect(await quiet).toBe(true);
  });
});

describe('Clearing a device exception', () => {
  it('hands that device the child rule it now follows', async () => {
    const f = await family();
    await putRule(f, { dailyLimitMinutes: 45 });
    await putRule(f, { dailyLimitMinutes: 180 }, f.laptop.id);

    const laptop = await connect({ token: deviceToken(f.laptop) });
    const seen = waitForEvent(laptop, 'screen_time_updated');

    const res = await request(app)
      .delete(`/api/screen-time/${f.child.id}?deviceId=${f.laptop.id}`)
      .set('Authorization', `Bearer ${f.token}`);
    expect(res.status).toBe(200);

    const rule = await seen;
    expect(rule.dailyLimitMinutes).toBe(45);
    expect(rule.deviceId).toBeNull();
  });

  /**
   * And from then on it is listening to the child's rule again — the exception
   * that was excluding it is gone, so the next child-wide edit must arrive.
   */
  it('puts the device back in the child-wide broadcast', async () => {
    const f = await family();
    await putRule(f, { dailyLimitMinutes: 180 }, f.laptop.id);
    await request(app)
      .delete(`/api/screen-time/${f.child.id}?deviceId=${f.laptop.id}`)
      .set('Authorization', `Bearer ${f.token}`);

    const laptop = await connect({ token: deviceToken(f.laptop) });
    const seen = waitForEvent(laptop, 'screen_time_updated');
    await putRule(f, { dailyLimitMinutes: 30 });

    expect((await seen).dailyLimitMinutes).toBe(30);
  });
});

/**
 * Grants are the deliberate exception to all of the above: they add up rather
 * than override, so a child-wide grant is minutes every device may spend —
 * including one that has its own rule. See `resolveScreenTimeGrants`.
 */
describe('Granting extra minutes', () => {
  it('reaches a device with its own rule when the grant is child-wide', async () => {
    const f = await family();
    await putRule(f, { dailyLimitMinutes: 180 }, f.laptop.id);

    const laptop = await connect({ token: deviceToken(f.laptop) });
    const seen = waitForEvent(laptop, 'screen_time_granted');

    const res = await request(app)
      .post(`/api/screen-time/${f.child.id}/grant`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ minutes: 15 });
    expect(res.status).toBe(201);

    expect((await seen).minutes).toBe(15);
  });

  it('reaches only the named device when the grant is narrowed', async () => {
    const f = await family();
    const laptop = await connect({ token: deviceToken(f.laptop) });
    const phone = await connect({ token: deviceToken(f.phone) });

    const heard = waitForEvent(laptop, 'screen_time_granted');
    const quiet = expectNoEvent(phone, 'screen_time_granted');
    await request(app)
      .post(`/api/screen-time/${f.child.id}/grant?deviceId=${f.laptop.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ minutes: 15 });

    expect((await heard).minutes).toBe(15);
    expect(await quiet).toBe(true);
  });
});
