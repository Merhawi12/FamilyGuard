/**
 * One family must never reach another family's child, on any route that names one.
 *
 * `authz.test.js` proves this for the handful of routes somebody thought to
 * write a case for. This walks the *route table* instead, so the guarantee
 * covers routes that do not exist yet: add a `:childId` endpoint with no
 * ownership check and this suite fails, rather than waiting for an audit to
 * notice. The same reasoning as the admin-permission sweep — the property
 * belongs to the surface, not to the individual handler.
 *
 * Ownership failures answer 404 rather than 403 throughout: "not found" is the
 * right answer to a stranger asking about a record they cannot see, and telling
 * them it exists but is not theirs is itself a disclosure. Both are accepted
 * here, because either is a refusal; what is not accepted is a 2xx, or a 500
 * from an id that reached the database.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

/** Every route the app actually serves, with its mount prefix resolved. */
const routeTable = () => {
  const routes = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        let mounted = '';
        if (layer.regexp && !layer.regexp.fast_slash) {
          const m = layer.regexp.toString().match(/^\/\^\\?(.*?)\\\/\?\(\?=\\\/\|\$\)/);
          if (m) mounted = m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
        }
        walk(layer.handle.stack, prefix + mounted);
      }
    }
  };
  walk(app._router.stack, '');
  return routes;
};

/**
 * A body good enough to get past request validation on any of these routes.
 *
 * Deliberately over-supplied rather than tailored per route: a 400 would pass
 * this suite for the wrong reason — the point is to be refused for *ownership*,
 * and a handler that validates before it authorises would hide that. Every
 * assertion below therefore also rejects 400.
 */
const BODY = {
  latitude: 43.65,
  longitude: -79.38,
  name: 'Probe',
  appName: 'Probe',
  appPackage: 'com.probe.app',
  domain: 'probe.example',
  action: 'block',
  url: 'https://probe.example',
  message: 'probe',
  dailyLimitMinutes: 60,
  minutes: 15,
  text: 'probe',
};

describe('no route lets one family reach another family’s child', () => {
  let victimChild;
  let victimDevice;
  let attackerToken;
  let childRoutes;

  beforeAll(() => {
    childRoutes = routeTable().filter((r) => r.path.includes(':childId'));
  });

  beforeEach(async () => {
    const victim = await createUser();
    victimChild = await createChild(victim.id);
    victimDevice = await createDevice(victimChild.id);

    const attacker = await createUser();
    // The attacker has a family of their own, so a handler that scopes to "some
    // child of mine" rather than "this child" still has something to find.
    const ownChild = await createChild(attacker.id);
    await createDevice(ownChild.id);
    attackerToken = tokenFor(attacker);
  });

  it('finds the routes it is meant to be covering', () => {
    // A refactor that renames the parameter would otherwise turn this whole
    // suite into a silent no-op.
    expect(childRoutes.length).toBeGreaterThanOrEqual(10);
  });

  it('refuses every one of them', async () => {
    const allowed = new Set([401, 403, 404]);
    const leaked = [];

    for (const { method, path } of childRoutes) {
      // Sub-resource ids are filled with the victim's own where one exists, so a
      // handler that checks the *rule* but not the child is caught too.
      const url = path
        .replace(':childId', victimChild.id)
        .replace(':deviceId', victimDevice.id)
        .replace(/:(ruleId|entryId|id)/g, '00000000-0000-4000-8000-000000000000');

      const res = await request(app)[method.toLowerCase()](url)
        .set('Authorization', `Bearer ${attackerToken}`)
        .send(BODY);

      if (!allowed.has(res.status)) leaked.push(`${method} ${path} → ${res.status}`);
    }

    expect(leaked).toEqual([]);
  });

  it('still lets the owning parent through the same routes', async () => {
    // The mirror image: a suite that refused everything — because the ids were
    // malformed, say — would pass the test above while proving nothing.
    const owner = await createUser();
    const child = await createChild(owner.id);

    const res = await request(app)
      .get(`/api/screen-time/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);

    expect(res.status).toBe(200);
  });
});

/**
 * And the mirror: a child's device token is not a parent's session.
 *
 * The two credentials are signed with the same secret and separated only by
 * which claims they carry — a device token has `{ deviceId, childId }` and no
 * `id`, so `authenticate` reaches `User.findByPk(undefined)` and depends on
 * Sequelize answering `null` for it. That is a library behaviour, not a check
 * anybody wrote, and it is the sort of thing that differs between dialects; the
 * whole parent surface rests on it, so it is swept rather than assumed. Run
 * under `npm run test:pg` too, which is the point of sweeping it at all.
 */
describe('a device token is not a parent credential', () => {
  /**
   * The parent-facing GET surface: everything a signed-in parent's screens read.
   *
   * `/me/` is the convention for a route the *device* owns and is meant to
   * reach — `/devices/me/rules`, `/chats/me/messages`. Excluded by the segment
   * rather than by a list of prefixes, because the second of those lives under
   * `/chats` and a prefix list quietly missed it: the sweep reported it as a
   * device token reaching a parent route, which it is not.
   */
  const PARENT_GET = (path) => path.startsWith('/api/')
    && !path.startsWith('/api/auth')   // public entry points and the session probe
    && !path.startsWith('/api/admin')  // staff-gated, and swept by the staff suites
    && !path.startsWith('/api/tasks')  // Cloud Scheduler, its own shared-secret gate
    && !path.includes('/me/')          // the device's own routes — see above
    && path !== '/api/health'
    && path !== '/api/ready';

  it('is refused by every parent route', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    const targets = routeTable()
      .filter((r) => r.method === 'GET' && PARENT_GET(r.path));
    expect(targets.length).toBeGreaterThanOrEqual(10);

    const reached = [];
    for (const { path } of targets) {
      const url = path
        .replace(':childId', child.id)
        .replace(':deviceId', device.id)
        .replace(/:(ruleId|entryId|sessionId|id)/g, '00000000-0000-4000-8000-000000000000');

      const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);
      if (res.status !== 401) reached.push(`GET ${path} → ${res.status}`);
    }

    expect(reached).toEqual([]);
  });

  it('still reaches its own routes', async () => {
    // Otherwise a token that had simply stopped working would pass the sweep.
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(device)}`);

    expect(res.status).toBe(200);
  });
});
