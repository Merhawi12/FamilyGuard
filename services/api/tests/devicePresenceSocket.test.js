const { io: Client } = require('socket.io-client');
const { httpServer, io } = require('../src/app');
const { Device } = require('../src/models');
const {
  createUser, tokenFor, createChild, createDevice, deviceToken,
} = require('./helpers');

/**
 * The parent's dashboard learns that a device came online, or went.
 *
 * This is the half that did not exist. The socket layer carried a
 * `device:heartbeat` handler no agent has ever emitted, which replied by
 * broadcasting `device:online` into `device:<its own id>` — a room containing
 * only that device's own sockets, with `broadcast` excluding the sender. So the
 * news went nowhere, nothing listened for it, and a parent watching the Children
 * screen saw whatever was true when the page loaded, for as long as they left it
 * open.
 *
 * Connecting and disconnecting is the signal now, and it reaches `parent:<id>`
 * on the `device_updated` event the screen already listens for.
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

const expectNoEvent = (socket, event, ms = 500) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event); resolve(true); }, ms);
  socket.once(event, () => { clearTimeout(timer); resolve(false); });
});

const family = async () => {
  const parent = await createUser();
  const child = await createChild(parent.id);
  const device = await createDevice(child.id, { lastSeen: new Date(Date.now() - 3 * 3600 * 1000) });
  return { parent, child, device };
};

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

describe('A device connecting', () => {
  it('tells its parent, on the event the Children screen listens for', async () => {
    const f = await family();
    const parentSocket = await connect({ token: tokenFor(f.parent) });

    const seen = waitForEvent(parentSocket, 'device_updated');
    await connect({ token: deviceToken(f.device) });

    const payload = await seen;
    expect(payload.deviceId).toBe(f.device.id);
    expect(payload.online).toBe(true);
    expect(typeof payload.lastSeen).toBe('string');
  });

  it('stamps lastSeen, so a page loaded later agrees with the event', async () => {
    const f = await family();
    const before = f.device.lastSeen;

    const parentSocket = await connect({ token: tokenFor(f.parent) });
    const seen = waitForEvent(parentSocket, 'device_updated');
    await connect({ token: deviceToken(f.device) });
    await seen;

    await f.device.reload();
    expect(new Date(f.device.lastSeen).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  /**
   * The isolation rule every other event here obeys: presence is family news,
   * not platform news.
   */
  it('does not tell another family', async () => {
    const mine = await family();
    const theirs = await family();

    const outsider = await connect({ token: tokenFor(theirs.parent) });
    const quiet = expectNoEvent(outsider, 'device_updated');
    await connect({ token: deviceToken(mine.device) });

    expect(await quiet).toBe(true);
  });
});

describe('A device dropping', () => {
  it('tells its parent it has gone', async () => {
    const f = await family();
    const deviceSocket = await connect({ token: deviceToken(f.device) });
    const parentSocket = await connect({ token: tokenFor(f.parent) });

    const seen = waitForEvent(parentSocket, 'device_updated');
    deviceSocket.disconnect();

    const payload = await seen;
    expect(payload.deviceId).toBe(f.device.id);
    expect(payload.online).toBe(false);
  });

  /**
   * One agent can hold two sockets — a reconnect overlapping the connection it
   * replaces. Announcing the phone offline the moment either one closes would
   * make a routine reconnect look like the child switching their phone off.
   */
  it('says nothing while another socket for the same device is still up', async () => {
    const f = await family();
    const first = await connect({ token: deviceToken(f.device) });
    await connect({ token: deviceToken(f.device) });
    const parentSocket = await connect({ token: tokenFor(f.parent) });

    const quiet = expectNoEvent(parentSocket, 'device_updated', 800);
    first.disconnect();

    expect(await quiet).toBe(true);
  });
});

describe('A parent connecting', () => {
  it('is not announced as a device', async () => {
    const f = await family();
    const watcher = await connect({ token: tokenFor(f.parent) });

    const quiet = expectNoEvent(watcher, 'device_updated');
    await connect({ token: tokenFor(f.parent) });

    expect(await quiet).toBe(true);
    // And nothing was written against a device that did not connect.
    const row = await Device.findByPk(f.device.id);
    expect(new Date(row.lastSeen).getTime()).toBe(new Date(f.device.lastSeen).getTime());
  });
});
