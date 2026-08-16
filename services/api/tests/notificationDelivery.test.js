/**
 * An announcement from the console has to *arrive*, not merely be filed.
 *
 * `POST /api/notifications` wrote a row per recipient and stopped there. The
 * family app's bell polls once a minute, so a maintenance notice took up to a
 * minute to reach a dashboard that was open the whole time — while the socket
 * every signed-in parent already holds sat unused beside it.
 *
 * The isolation check is the important half: a notification row belongs to one
 * account and the client marks it read by id, so delivering one customer's row
 * into another customer's bell would be worse than the delay it replaced.
 */
const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, httpServer, io } = require('../src/app');
const { createUser, tokenFor } = require('./helpers');

let baseUrl;
const openClients = [];

const connect = (token) => new Promise((resolve, reject) => {
  const socket = Client(baseUrl, {
    auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false,
  });
  openClients.push(socket);
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
});

const waitForEvent = (socket, event, ms = 1500) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});

const expectNoEvent = (socket, event, ms = 500) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event); resolve(true); }, ms);
  socket.once(event, () => { clearTimeout(timer); resolve(false); });
});

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

describe('an operator announcement', () => {
  it('reaches an open dashboard immediately rather than on the next poll', async () => {
    const staff = await createUser({ role: 'super_admin' });
    const parent = await createUser();
    const socket = await connect(tokenFor(parent));

    const delivered = waitForEvent(socket, 'notification:new');

    const res = await request(app)
      .post('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ broadcast: true, title: 'Scheduled maintenance', message: 'Tonight at 02:00 UTC.' });

    expect(res.status).toBe(201);

    const row = await delivered;
    expect(row).toMatchObject({ title: 'Scheduled maintenance', userId: parent.id });
    // Carries an id, so the bell can key it and mark it read. Postgres withholds
    // generated values from bulkCreate unless asked.
    expect(row.id).toBeTruthy();
  });

  it('delivers a targeted notice only to the account it names', async () => {
    const staff = await createUser({ role: 'super_admin' });
    const target = await createUser();
    const bystander = await createUser();

    const theirs = await connect(tokenFor(target));
    const others = await connect(tokenFor(bystander));

    const delivered = waitForEvent(theirs, 'notification:new');
    const quiet = expectNoEvent(others, 'notification:new');

    await request(app)
      .post('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ userId: target.id, title: 'About your account', message: 'Please get in touch.' });

    expect((await delivered).userId).toBe(target.id);
    expect(await quiet).toBe(true);
  });

  it('excludes staff from a customer broadcast, on the socket as well as in the table', async () => {
    const sender = await createUser({ role: 'super_admin' });
    const colleague = await createUser({ role: 'support' });
    const theirSocket = await connect(tokenFor(colleague));

    const quiet = expectNoEvent(theirSocket, 'notification:new');

    await request(app)
      .post('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ broadcast: true, title: 'Customer news', message: 'For families only.' });

    expect(await quiet).toBe(true);
  });
});
