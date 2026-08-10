/**
 * Revoking a session has to cut the realtime feed as well as the REST API.
 *
 * The socket carries live location, alerts and family chat, so a token that has
 * been signed out, force-logged-out by an admin, or invalidated by a password
 * reset must not keep a channel open — the handshake refuses it, and any socket
 * already connected is dropped.
 */
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { app, httpServer, io } = require('../src/app');
const { createUser } = require('./helpers');
const { createSession, revokeAllSessions } = require('../src/utils/session');

let port;

beforeAll(async () => {
  await new Promise((resolve) => httpServer.listen(0, resolve));
  port = httpServer.address().port;
});

afterAll(async () => {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

const connect = (token) =>
  new Promise((resolve) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: { token }, transports: ['websocket'], reconnection: false,
    });
    socket.on('connect', () => resolve({ ok: true, socket }));
    socket.on('connect_error', (err) => resolve({ ok: false, error: err.message }));
  });

const sessionTokenFor = async (user) => {
  const fakeReq = { ip: '127.0.0.1', headers: {}, socket: {} };
  const { token } = await createSession(fakeReq, user.id);
  return token;
};

describe('socket handshake honours session revocation', () => {
  it('accepts a live session', async () => {
    const user = await createUser();
    const result = await connect(await sessionTokenFor(user));

    expect(result.ok).toBe(true);
    result.socket.disconnect();
  });

  it('refuses a token whose session was signed out', async () => {
    const user = await createUser();
    const token = await sessionTokenFor(user);

    await request(app).post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const result = await connect(token);
    expect(result.ok).toBe(false);
  });

  it('refuses a token after an admin force-logout', async () => {
    const user = await createUser();
    const token = await sessionTokenFor(user);

    await revokeAllSessions(user.id);

    const result = await connect(token);
    expect(result.ok).toBe(false);
  });

  it('refuses a token belonging to a deactivated account', async () => {
    const user = await createUser();
    const token = await sessionTokenFor(user);

    await user.update({ isActive: false });

    const result = await connect(token);
    expect(result.ok).toBe(false);
  });
});

describe('revoking drops sockets that are already connected', () => {
  it('disconnects a live socket when every session is revoked', async () => {
    const user = await createUser();
    const token = await sessionTokenFor(user);

    const result = await connect(token);
    expect(result.ok).toBe(true);

    const disconnected = new Promise((resolve) => result.socket.on('disconnect', resolve));

    // The realtime rooms are keyed by user, which is how the revoke reaches
    // a connection that authenticated before the token was invalidated.
    await revokeAllSessions(user.id, io);

    await expect(disconnected).resolves.toBeDefined();
  });
});
