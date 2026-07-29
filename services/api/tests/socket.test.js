const { io: Client } = require('socket.io-client');
const { httpServer, io } = require('../src/app');
const { Alert } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

let baseUrl;
const openClients = [];

// Connect a client and resolve on success / reject on the server's connect_error.
function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = Client(baseUrl, {
      auth,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    openClients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

// Resolve with the event payload, or reject if it does not arrive in time.
function waitForEvent(socket, event, ms = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

// Resolve true if the event does NOT arrive within ms (used for isolation checks).
function expectNoEvent(socket, event, ms = 400) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event); resolve(true); }, ms);
    socket.once(event, () => { clearTimeout(timer); resolve(false); });
  });
}

beforeAll((done) => {
  httpServer.listen(0, () => {
    baseUrl = `http://localhost:${httpServer.address().port}`;
    done();
  });
});

afterEach(() => {
  while (openClients.length) openClients.pop().disconnect();
});

afterAll((done) => {
  io.close(() => done());
});

describe('Socket.IO handshake authentication (C1)', () => {
  it('rejects a connection with no token', async () => {
    await expect(connect(undefined)).rejects.toThrow(/authentication required/i);
  });

  it('rejects a connection with an invalid token', async () => {
    await expect(connect({ token: 'not-a-jwt' })).rejects.toThrow(/invalid token/i);
  });

  it('accepts a valid parent token', async () => {
    const parent = await createUser();
    const socket = await connect({ token: tokenFor(parent) });
    expect(socket.connected).toBe(true);
  });

  it('accepts a valid device token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const socket = await connect({ token: deviceToken(device) });
    expect(socket.connected).toBe(true);
  });

  it('auto-joins the authenticated parent room and isolates families', async () => {
    const parentA = await createUser();
    const parentB = await createUser();
    const socketA = await connect({ token: tokenFor(parentA) });
    const socketB = await connect({ token: tokenFor(parentB) });

    const received = waitForEvent(socketA, 'alert:new');
    const leaked = expectNoEvent(socketB, 'alert:new');

    // Server-side emit to parent A's room only.
    io.to(`parent:${parentA.id}`).emit('alert:new', { id: 'x', message: 'hi A' });

    await expect(received).resolves.toMatchObject({ message: 'hi A' });
    await expect(leaked).resolves.toBe(true); // B never sees A's alert
  });

  it('ignores a spoofed join:parent — a client cannot enter another family\'s room', async () => {
    const victim = await createUser();
    const attacker = await createUser();
    const attackerSocket = await connect({ token: tokenFor(attacker) });

    // Attacker tries to join the victim's room via the legacy event.
    attackerSocket.emit('join:parent', victim.id);

    const leaked = expectNoEvent(attackerSocket, 'alert:new', 500);
    io.to(`parent:${victim.id}`).emit('alert:new', { id: 'y', message: 'victim only' });

    await expect(leaked).resolves.toBe(true); // spoof did not grant access
  });

  it('auto-joins a device to its child room for rule updates', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const socket = await connect({ token: deviceToken(device) });

    const received = waitForEvent(socket, 'rules_updated');
    io.to(`child:${child.id}`).emit('rules_updated', { type: 'app' });
    await expect(received).resolves.toMatchObject({ type: 'app' });
  });
});

describe('Child-emitted alerts reach the parent (feature: block/limit notifications)', () => {
  it('a device emitting alert:blocked_app creates a parent alert and pushes alert:new', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const parentSocket = await connect({ token: tokenFor(parent) });
    const deviceSocket = await connect({ token: deviceToken(device) });

    const received = waitForEvent(parentSocket, 'alert:new', 2000);
    deviceSocket.emit('alert:blocked_app', { appName: 'TikTok' });

    const alert = await received;
    expect(alert.type).toBe('blocked_app_attempt');

    const rows = await Alert.findAll({ where: { parentId: parent.id, type: 'blocked_app_attempt' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].childId).toBe(child.id);
  });

  it('a device emitting alert:screen_time_exceeded creates a high-severity alert', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const parentSocket = await connect({ token: tokenFor(parent) });
    const deviceSocket = await connect({ token: deviceToken(device) });

    const received = waitForEvent(parentSocket, 'alert:new', 2000);
    deviceSocket.emit('alert:screen_time_exceeded');

    const alert = await received;
    expect(alert.type).toBe('screen_time_exceeded');
    expect(alert.severity).toBe('high');
  });

  it('a parent socket CANNOT forge a child alert (role guard)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const parentSocket = await connect({ token: tokenFor(parent) });

    parentSocket.emit('alert:blocked_app', { appName: 'Forged' });
    await new Promise((r) => setTimeout(r, 300)); // give the server a chance to (not) act

    const rows = await Alert.findAll({ where: { parentId: parent.id } });
    expect(rows).toHaveLength(0);
  });
});
