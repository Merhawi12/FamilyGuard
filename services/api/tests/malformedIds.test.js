/**
 * A path parameter that is not a UUID must read as "not found", on either engine.
 *
 * Every id column on this schema is `UUID`. Postgres rejects a malformed value
 * at the database — `invalid input syntax for type uuid` — so a `where: { id }`
 * built straight from `req.params` throws, and the route answers 500 to what is
 * plainly a 404. SQLite has no UUID type and quietly matches nothing, which is
 * why the whole class stayed invisible: the suite's default engine cannot see
 * it, and only Cloud SQL can.
 *
 * `utils/ids.isUuid` is the guard, and it was applied to three controllers out
 * of a dozen. These cases are the rest of them, and they are written to pass on
 * SQLite too so the file is not silently inert on the default run.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor, createChild } = require('./helpers');
const { ROLES, defaultPermissionsFor } = require('../src/config/roles');

const BAD = 'not-a-uuid';

let parent;
let token;
let childId;

beforeEach(async () => {
  parent = await createUser({ plan: 'premium' });
  token = tokenFor(parent);
  childId = (await createChild(parent.id)).id;
});

const auth = (req) => req.set('Authorization', `Bearer ${token}`);

describe('malformed :childId path params', () => {
  const childRoutes = [
    ['get', `/api/activity/${BAD}`],
    ['get', `/api/activity/${BAD}/web-history`],
    ['get', `/api/screen-time/${BAD}`],
    ['put', `/api/screen-time/${BAD}`],
    ['get', `/api/reports/${BAD}/daily`],
    ['get', `/api/reports/${BAD}/weekly`],
    ['get', `/api/blocking/${BAD}/apps`],
    ['get', `/api/blocking/${BAD}/apps/known`],
    ['post', `/api/blocking/${BAD}/apps`],
    ['get', `/api/blocking/${BAD}/websites`],
    ['post', `/api/blocking/${BAD}/websites`],
    ['get', `/api/chats/${BAD}/messages`],
    ['post', `/api/chats/${BAD}/messages`],
    ['get', `/api/locations/${BAD}/current`],
    ['get', `/api/locations/${BAD}/history`],
    ['post', `/api/locations/${BAD}/manual`],
  ];

  it.each(childRoutes)('%s %s answers 404, not 500', async (method, path) => {
    const res = await auth(request(app)[method](path)).send({});
    expect(res.status).toBe(404);
  });
});

describe('malformed :id path params', () => {
  const idRoutes = [
    ['put', `/api/children/${BAD}`],
    ['delete', `/api/children/${BAD}`],
    ['patch', `/api/devices/${BAD}`],
    ['post', `/api/devices/${BAD}/link`],
    ['delete', `/api/devices/${BAD}`],
    ['put', `/api/safe-zones/${BAD}`],
    ['delete', `/api/safe-zones/${BAD}`],
    ['put', `/api/contacts/${BAD}`],
    ['delete', `/api/contacts/${BAD}`],
    ['delete', `/api/auth/sessions/${BAD}`],
  ];

  it.each(idRoutes)('%s %s answers 404, not 500', async (method, path) => {
    const res = await auth(request(app)[method](path)).send({});
    expect(res.status).toBe(404);
  });

  it('PUT /api/alerts/:id/read answers 404, not 500', async () => {
    const res = await auth(request(app).put(`/api/alerts/${BAD}/read`)).send({});
    expect(res.status).toBe(404);
  });
});

describe('malformed ids in request bodies', () => {
  it('POST /api/activity with a malformed childId answers 404, not 500', async () => {
    const res = await auth(request(app).post('/api/activity')).send({
      childId: BAD,
      deviceId: BAD,
      appName: 'Test',
      category: 'app_usage',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/activity with a malformed deviceId answers 404, not 500', async () => {
    const res = await auth(request(app).post('/api/activity')).send({
      childId,
      deviceId: BAD,
      appName: 'Test',
      category: 'app_usage',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/devices/link with a malformed childId answers 404, not 500', async () => {
    const res = await auth(request(app).post('/api/devices/link')).send({
      childId: BAD,
      deviceName: 'Phone',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/uploads/child-avatar with a malformed childId answers 404, not 500', async () => {
    const res = await auth(request(app).post('/api/uploads/child-avatar')).send({
      childId: BAD,
      contentType: 'image/png',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/safe-zones with a malformed childId answers 4xx, not 500', async () => {
    const res = await auth(request(app).post('/api/safe-zones')).send({
      name: 'Home',
      childId: BAD,
      latitude: 1,
      longitude: 1,
      radiusMeters: 100,
    });
    expect(res.status).toBeLessThan(500);
  });

  it('POST /api/contacts with a malformed childId answers 4xx, not 500', async () => {
    const res = await auth(request(app).post('/api/contacts')).send({
      name: 'Gran',
      phone: '+14155550100',
      childId: BAD,
    });
    expect(res.status).toBeLessThan(500);
  });
});

/**
 * The console reaches these with whatever is in its address bar, so the same
 * rule applies: a mistyped id is a 404 the operator can read, not a 500 that
 * looks like the platform is broken.
 */
describe('admin console — malformed ids', () => {
  let boss;
  let bossToken;

  beforeEach(async () => {
    boss = await createUser({
      role: ROLES.SUPER_ADMIN,
      permissions: defaultPermissionsFor(ROLES.SUPER_ADMIN),
    });
    bossToken = tokenFor(boss);
  });

  const asAdmin = (req) => req.set('Authorization', `Bearer ${bossToken}`);

  const notFound = [
    ['put', `/api/admin/staff/${BAD}`],
    ['patch', `/api/admin/staff/${BAD}/status`],
    ['post', `/api/admin/staff/${BAD}/reset-password`],
    ['delete', `/api/admin/staff/${BAD}`],
    ['put', `/api/admin/users/${BAD}`],
    ['patch', `/api/admin/users/${BAD}/role`],
    ['patch', `/api/admin/users/${BAD}/approve`],
    ['post', `/api/admin/users/${BAD}/reset-password`],
    ['patch', `/api/admin/clients/${BAD}/toggle-block`],
    ['patch', `/api/admin/clients/${BAD}/plan`],
    ['delete', `/api/admin/clients/${BAD}`],
    ['delete', `/api/admin/sessions/${BAD}`],
    ['delete', `/api/admin/users/${BAD}/sessions`],
  ];

  // A body that satisfies every one of these routes' own validation, so each
  // reaches the id lookup that is what this file is actually about.
  const validBody = { role: ROLES.FINANCE, plan: 'premium', isActive: true, name: 'Someone' };

  it.each(notFound)('%s %s answers 404, not 500', async (method, path) => {
    const res = await asAdmin(request(app)[method](path)).send(validBody);
    expect(res.status).toBe(404);
  });

  // A list filtered by an id that cannot exist is empty, not an error.
  const emptyList = [
    ['get', `/api/admin/users/${BAD}/sessions`],
    ['get', `/api/admin/users/${BAD}/transactions`],
  ];

  it.each(emptyList)('%s %s answers 200 with an empty list', async (method, path) => {
    const res = await asAdmin(request(app)[method](path));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
