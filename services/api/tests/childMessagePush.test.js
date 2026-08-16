/**
 * The other direction.
 *
 * `sendMessage` has always pushed a parent's message to the child's phone,
 * because a message the child only sees if the app happens to be open is not a
 * message. The child→parent direction did neither: it emitted `chat:message` on
 * a socket that exists only while a dashboard is open in a browser, and stopped.
 * Nothing else covered it — the alert bell carries alerts and platform
 * announcements, never chat — so a child asking for more screen time, or saying
 * they were staying late, produced nothing whatsoever on their parent's phone.
 *
 * The child app's own home screen sells this: "Need more time? Send your parent
 * a message and ask." The gap was worst in exactly the case the product invites.
 */
const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, httpServer, io } = require('../src/app');
const { Alert } = require('../src/models');
const push = require('../src/utils/pushService');
const { flushBackground } = require('../src/utils/background');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

const sendFromChild = (device, body) =>
  request(app)
    .post(`/api/chats/${device.childId}/messages/from-child`)
    .set('Authorization', `Bearer ${deviceToken(device)}`)
    .send(body);

describe('a message from a child reaches a parent who is not looking', () => {
  it('pushes it, naming the child', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id, { name: 'Sarah' });
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    const res = await sendFromChild(device, { text: 'Can I have 20 more minutes?' });
    expect(res.status).toBe(201);
    await flushBackground();

    expect(spy).toHaveBeenCalledWith(parent.id, expect.objectContaining({
      title: 'Message from Sarah',
      body: 'Can I have 20 more minutes?',
      data: expect.objectContaining({ type: 'chat', childId: child.id, url: '/dashboard/messages' }),
    }));
    spy.mockRestore();
  });

  it('says so differently for a check-in', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id, { name: 'Ben' });
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    await sendFromChild(device, { text: 'Got to school', messageType: 'check_in' });
    await flushBackground();

    expect(spy).toHaveBeenCalledWith(parent.id, expect.objectContaining({ title: 'Ben checked in' }));
    spy.mockRestore();
  });

  it('trims a long message to a notification-sized preview', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    await sendFromChild(device, { text: 'x'.repeat(400) });
    await flushBackground();

    const { body } = spy.mock.calls[0][1];
    expect(body.length).toBeLessThanOrEqual(140);
    expect(body.endsWith('…')).toBe(true);
    spy.mockRestore();
  });

  it('sends one notification for an emergency, not two', async () => {
    // `emergency` already raises an alert, and `createAlert` pushes that with
    // urgent wording. A second, quieter push about the same event a moment later
    // would compete with the one that matters.
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    await sendFromChild(device, { text: 'Help', messageType: 'emergency' });
    await flushBackground();
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].title).toMatch(/urgent/i);
    expect(await Alert.count({ where: { parentId: parent.id, type: 'emergency_button' } })).toBe(1);
    spy.mockRestore();
  });

  it('honours a parent who has switched push off', async () => {
    const parent = await createUser({ notificationPrefs: JSON.stringify({ pushAlerts: false }) });
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 0, failed: 0, recipients: 0 });

    await sendFromChild(device, { text: 'Hello' });
    await flushBackground();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('stores and delivers the message even when the push service is down', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockRejectedValue(new Error('push service down'));

    const res = await sendFromChild(device, { text: 'Still sent' });
    expect(res.status).toBe(201);
    await flushBackground();
    spy.mockRestore();
  });
});

describe('the socket path the child app prefers does the same', () => {
  let baseUrl;
  const openClients = [];

  beforeAll((done) => {
    httpServer.listen(0, () => {
      baseUrl = `http://localhost:${httpServer.address().port}`;
      done();
    });
  });

  afterEach(() => { while (openClients.length) openClients.pop().disconnect(); });
  afterAll((done) => { io.close(() => done()); });

  const connect = (token) => new Promise((resolve, reject) => {
    const socket = Client(baseUrl, {
      auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false,
    });
    openClients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

  /**
   * The one that would have gone on being missed: the child app sends over the
   * socket whenever it has one, so without this the *better* the child's
   * connection the less likely their parent was to hear about the message.
   */
  it('pushes a message sent over the socket', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id, { name: 'Mia' });
    const device = await createDevice(child.id);
    const spy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, recipients: 1 });

    const socket = await connect(deviceToken(device));
    const delivered = new Promise((resolve) => socket.once('chat:delivered', resolve));
    socket.emit('chat:send', { text: 'On my way home' });
    await delivered;
    await flushBackground();

    expect(spy).toHaveBeenCalledWith(parent.id, expect.objectContaining({
      title: 'Message from Mia',
      body: 'On my way home',
    }));
    spy.mockRestore();
  });
});
