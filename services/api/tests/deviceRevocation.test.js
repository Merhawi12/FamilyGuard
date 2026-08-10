/**
 * What must stop when access is taken away.
 *
 * A device token authenticates against `Device.isActive` alone, and the socket
 * handshake only runs when a socket connects. Both facts made revocation
 * partial: removing a child left its phone fully credentialed, and removing a
 * device left an already-open socket streaming. These lock down the whole cut —
 * REST, realtime, the device list and the plan's device allowance.
 */
const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, httpServer, io } = require('../src/app');
const { Device } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

let baseUrl;
const openClients = [];

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = Client(baseUrl, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
    openClients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/** Resolves true if the event does not arrive — the isolation assertion. */
function expectNoEvent(socket, event, ms = 400) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event); resolve(true); }, ms);
    socket.once(event, () => { clearTimeout(timer); resolve(false); });
  });
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeAll((done) => {
  httpServer.listen(0, () => { baseUrl = `http://localhost:${httpServer.address().port}`; done(); });
});
afterEach(() => { while (openClients.length) openClients.pop().disconnect(); });
afterAll(() => { io.close(); httpServer.close(); });

describe('Removing a child revokes its devices', () => {
  it('stops the device posting activity and heartbeats', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const devTok = deviceToken(device);

    // Working before the removal, so the assertion below means something.
    await request(app).post('/api/devices/me/heartbeat')
      .set('Authorization', `Bearer ${devTok}`).send({}).expect(200);

    await request(app).delete(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    await request(app).post('/api/devices/me/heartbeat')
      .set('Authorization', `Bearer ${devTok}`).send({}).expect(401);
    await request(app).post('/api/devices/me/activity')
      .set('Authorization', `Bearer ${devTok}`).send({ appName: 'Ghost', durationSeconds: 60 }).expect(401);
    await request(app).get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${devTok}`).expect(401);
  });

  it('marks the devices inactive and drops them from the device list', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await request(app).delete(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    await device.reload();
    expect(device.isActive).toBe(false);

    const list = await request(app).get('/api/devices')
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);
    expect(list.body.map((d) => d.id)).not.toContain(device.id);
  });

  it('frees the allowance slot the removed child was holding', async () => {
    // A Free-plan parent covers one device. Removing the child has to release it,
    // or a replacement can never be linked.
    const parent = await createUser({ plan: 'free', trialEndsAt: null });
    const first = await createChild(parent.id, { name: 'First' });
    await createDevice(first.id);

    await request(app).delete(`/api/children/${first.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    const replacement = await createChild(parent.id, { name: 'Second' });
    await request(app).post('/api/devices/link')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: replacement.id, deviceName: 'New Phone' })
      .expect(200);
  });

  it('disconnects the live socket the device was holding', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const sock = await connect({ token: deviceToken(device) });
    expect(sock.connected).toBe(true);

    await request(app).delete(`/api/children/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    await settle();
    expect(sock.connected).toBe(false);
  });
});

describe('Removing a device cuts its live socket', () => {
  it('disconnects it rather than waiting for a reconnect', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const sock = await connect({ token: deviceToken(device) });
    expect(sock.connected).toBe(true);

    await request(app).delete(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    await settle();
    expect(sock.connected).toBe(false);
    expect((await Device.findByPk(device.id)).isActive).toBe(false);
  });

  /* Cutting the socket stops the phone reporting; it does not tell the phone
     anything. Without a reason on the way out, a child device sat on a "Linked"
     badge, kept enforcing the last rules it had, and retried a token that could
     never work again. */
  it('tells the device it was unlinked before hanging up', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const sock = await connect({ token: deviceToken(device) });
    const told = new Promise((resolve) => sock.once('device:unlinked', resolve));

    await request(app).delete(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    expect((await told).code).toBe('device_unlinked');
  });
});

/**
 * The handshake has to be as specific as the REST middleware.
 *
 * A phone that is offline when its device is removed never sees the event above;
 * the reconnect is where it finds out. Both refusals used to read "Device
 * revoked", so the client could not tell a deletion it should act on from a
 * block it should wait out.
 */
describe('A refused handshake says why', () => {
  const refusal = (auth) => connect(auth).then(
    (socket) => ({ ok: true, socket }),
    (err) => ({ ok: false, message: err.message, code: err.data?.code }),
  );

  it('refuses a removed device as permanently unlinked', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    await request(app).delete(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    const result = await refusal({ token });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('device_unlinked');
  });

  it('refuses a blocked parent\'s device as suspended', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    await parent.update({ isActive: false });

    const result = await refusal({ token });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('account_suspended');
  });
});

/**
 * The one moment the two apps meet.
 *
 * The link sheet in the family app shows a code and then has no way of knowing
 * it was used: the parent had to close the sheet, which triggered a reload, and
 * hope. A phone that linked while they were still looking at the code left them
 * staring at a screen that had already stopped being true.
 */
describe('Linking a device tells the parent in realtime', () => {
  it('emits device:linked to the parent when the code is confirmed', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const auth = `Bearer ${tokenFor(parent)}`;

    const parentSock = await connect({ token: tokenFor(parent) });
    const linked = new Promise((resolve) => parentSock.once('device:linked', resolve));

    const gen = await request(app).post('/api/devices/link').set('Authorization', auth)
      .send({ childId: child.id, deviceName: 'Ada Phone', type: 'android' }).expect(200);

    await request(app).post('/api/devices/confirm')
      .send({ code: gen.body.code, deviceId: gen.body.device.id, osVersion: 'Android 14' })
      .expect(200);

    const event = await linked;
    expect(event.deviceId).toBe(gen.body.device.id);
    expect(event.childId).toBe(child.id);
    expect(event.name).toBe('Ada Phone');
    expect(event.osVersion).toBe('Android 14');
  });

  it('does not tell another family about it', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const stranger = await createUser();

    const strangerSock = await connect({ token: tokenFor(stranger) });
    const quiet = expectNoEvent(strangerSock, 'device:linked');

    const gen = await request(app).post('/api/devices/link')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, deviceName: 'Phone' }).expect(200);
    await request(app).post('/api/devices/confirm').send({ code: gen.body.code }).expect(200);

    expect(await quiet).toBe(true);
  });
});

describe('A child device is not in the family broadcast room', () => {
  it('does not receive an alert raised about a sibling', async () => {
    const parent = await createUser();
    const childA = await createChild(parent.id, { name: 'A' });
    const childB = await createChild(parent.id, { name: 'B' });
    const deviceA = await createDevice(childA.id);
    const deviceB = await createDevice(childB.id);

    const sockA = await connect({ token: deviceToken(deviceA) });
    const quiet = expectNoEvent(sockA, 'alert:new');

    // B's phone raises an emergency; only the parent may hear it.
    const sockB = await connect({ token: deviceToken(deviceB) });
    sockB.emit('chat:send', { text: 'help', messageType: 'emergency' });

    expect(await quiet).toBe(true);
  });

  it('does not receive a sibling location fix', async () => {
    const parent = await createUser();
    const childA = await createChild(parent.id, { name: 'A' });
    const childB = await createChild(parent.id, { name: 'B' });
    const sockA = await connect({ token: deviceToken(await createDevice(childA.id)) });
    const sockB = await connect({ token: deviceToken(await createDevice(childB.id)) });

    const quiet = expectNoEvent(sockA, 'location:update');
    sockB.emit('location:update', { latitude: 12, longitude: 34 });
    expect(await quiet).toBe(true);
  });

  it('still delivers the parent the events it depends on', async () => {
    // The isolation above must not have cut the feed it was protecting.
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const parentSock = await connect({ token: tokenFor(parent) });
    const childSock = await connect({ token: deviceToken(device) });

    const gotLocation = new Promise((resolve) => parentSock.once('location:update', resolve));
    childSock.emit('location:update', { latitude: 1, longitude: 2 });
    const fix = await gotLocation;
    expect(fix.childId).toBe(child.id);
  });

  it('still delivers the child its own chat thread', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const childSock = await connect({ token: deviceToken(device) });
    const gotMessage = new Promise((resolve) => childSock.once('chat:message', resolve));

    await request(app).post(`/api/chats/${child.id}/messages`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ text: 'dinner time' }).expect(201);

    expect((await gotMessage).text).toBe('dinner time');
  });
});
