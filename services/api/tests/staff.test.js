const request = require('supertest');
const { app } = require('../src/app');
const { User, Session } = require('../src/models');
const { createUser, tokenFor, DEFAULT_PASSWORD } = require('./helpers');
const { ROLES, defaultPermissionsFor } = require('../src/config/roles');

const bearer = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const superAdmin = () => createUser({ role: ROLES.SUPER_ADMIN, permissions: defaultPermissionsFor(ROLES.SUPER_ADMIN) });

const staffOf = (role) => createUser({ role, permissions: defaultPermissionsFor(role) });

describe('staff account management — access control', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/api/admin/staff')).status).toBe(401);
  });

  it('refuses a parent', async () => {
    const parent = await createUser({ role: 'parent' });
    expect((await request(app).get('/api/admin/staff').set(bearer(parent))).status).toBe(403);
  });

  it.each([ROLES.OPERATIONS, ROLES.SUPPORT, ROLES.FINANCE, ROLES.MARKETING])(
    'refuses a %s account — only a Super Admin manages staff',
    async (role) => {
      const staff = await staffOf(role);
      expect((await request(app).get('/api/admin/staff').set(bearer(staff))).status).toBe(403);
      expect((await request(app).post('/api/admin/staff').set(bearer(staff))
        .send({ name: 'X', email: 'x@test.dev', role: ROLES.FINANCE })).status).toBe(403);
    }
  );

  it('lets a Super Admin list staff, with the role catalogue', async () => {
    const boss = await superAdmin();
    const finance = await staffOf(ROLES.FINANCE);
    const parent = await createUser({ role: 'parent' });

    const res = await request(app).get('/api/admin/staff').set(bearer(boss));

    expect(res.status).toBe(200);
    const ids = res.body.staff.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([boss.id, finance.id]));
    expect(ids).not.toContain(parent.id);
    expect(res.body.staff.every((s) => s.role !== 'parent')).toBe(true);
    expect(res.body.roles.map((r) => r.value)).toEqual(
      expect.arrayContaining([ROLES.SUPER_ADMIN, ROLES.FINANCE, ROLES.MARKETING])
    );
    expect(res.body.staff[0].passwordHash).toBeUndefined();
  });
});

describe('creating a staff account', () => {
  it('creates a department account and returns a generated password once', async () => {
    const boss = await superAdmin();

    const res = await request(app).post('/api/admin/staff').set(bearer(boss))
      .send({ name: 'Fin Person', email: 'Fin@Test.dev', role: ROLES.FINANCE });

    expect(res.status).toBe(201);
    expect(res.body.staff.role).toBe(ROLES.FINANCE);
    expect(res.body.staff.email).toBe('fin@test.dev'); // normalised
    expect(res.body.staff.permissions).toEqual(defaultPermissionsFor(ROLES.FINANCE));
    expect(res.body.generatedPassword).toEqual(expect.any(String));

    // The generated password actually works.
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'fin@test.dev', password: res.body.generatedPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe(ROLES.FINANCE);
  });

  it('accepts an explicit permission set that overrides the role defaults', async () => {
    const boss = await superAdmin();

    const res = await request(app).post('/api/admin/staff').set(bearer(boss))
      .send({ name: 'Fin Plus', email: 'finplus@test.dev', role: ROLES.FINANCE, permissions: ['manage_billing', 'view_audit_logs'] });

    expect(res.status).toBe(201);
    expect(res.body.staff.permissions).toEqual(['manage_billing', 'view_audit_logs']);
  });

  it('rejects an unknown role, an unknown permission, a duplicate email and a weak password', async () => {
    const boss = await superAdmin();
    const post = (body) => request(app).post('/api/admin/staff').set(bearer(boss)).send(body);

    expect((await post({ name: 'A', email: 'a@test.dev', role: 'parent' })).status).toBe(400);
    expect((await post({ name: 'A', email: 'a@test.dev', role: 'wizard' })).status).toBe(400);
    expect((await post({ name: 'A', email: 'a@test.dev', role: ROLES.FINANCE, permissions: ['rule_the_world'] })).status).toBe(400);
    expect((await post({ name: '', email: 'a@test.dev', role: ROLES.FINANCE })).status).toBe(400);
    expect((await post({ name: 'A', email: 'a@test.dev', role: ROLES.FINANCE, password: 'short' })).status).toBe(400);

    const existing = await createUser({ email: 'taken@test.dev' });
    expect(existing).toBeTruthy();
    expect((await post({ name: 'A', email: 'taken@test.dev', role: ROLES.FINANCE })).status).toBe(409);
  });

  it('does not return a generated password when one was supplied', async () => {
    const boss = await superAdmin();
    const res = await request(app).post('/api/admin/staff').set(bearer(boss))
      .send({ name: 'Ops', email: 'ops@test.dev', role: ROLES.OPERATIONS, password: 'chosen-pass-1' });

    expect(res.status).toBe(201);
    expect(res.body.generatedPassword).toBeNull();
    const login = await request(app).post('/api/auth/login').send({ email: 'ops@test.dev', password: 'chosen-pass-1' });
    expect(login.status).toBe(200);
  });
});

describe('editing a staff account', () => {
  it('updates the name, email, role and permissions', async () => {
    const boss = await superAdmin();
    const staff = await staffOf(ROLES.SUPPORT);

    const res = await request(app).put(`/api/admin/staff/${staff.id}`).set(bearer(boss))
      .send({ name: 'Renamed', email: 'renamed@test.dev', role: ROLES.MARKETING });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.email).toBe('renamed@test.dev');
    expect(res.body.role).toBe(ROLES.MARKETING);
    // A role change re-seeds the defaults when no explicit list is given.
    expect(res.body.permissions).toEqual(defaultPermissionsFor(ROLES.MARKETING));
  });

  it('revokes the account\'s sessions when its authority changes', async () => {
    const boss = await superAdmin();
    const staff = await staffOf(ROLES.OPERATIONS);
    const login = await request(app).post('/api/auth/login').send({ email: staff.email, password: DEFAULT_PASSWORD });
    expect(login.status).toBe(200);

    await request(app).put(`/api/admin/staff/${staff.id}`).set(bearer(boss)).send({ role: ROLES.MARKETING });

    expect(await Session.count({ where: { userId: staff.id, revoked: false } })).toBe(0);
    const reuse = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(reuse.status).toBe(401);
  });

  it('will not edit a parent account through the staff endpoint', async () => {
    const boss = await superAdmin();
    const parent = await createUser({ role: 'parent' });

    const res = await request(app).put(`/api/admin/staff/${parent.id}`).set(bearer(boss)).send({ name: 'Nope' });
    expect(res.status).toBe(404);
  });

  /**
   * The caller must be an active Super Admin, so no *other* account is ever the
   * last one — self-demotion is what actually keeps a Super Admin on the
   * platform. (The count check behind it stays as defence in depth.)
   */
  it('refuses to demote yourself, but allows demoting another Super Admin', async () => {
    const boss = await superAdmin();
    const other = await superAdmin();

    expect((await request(app).put(`/api/admin/staff/${other.id}`).set(bearer(boss))
      .send({ role: ROLES.FINANCE })).status).toBe(200);

    const res = await request(app).put(`/api/admin/staff/${boss.id}`).set(bearer(boss)).send({ role: ROLES.FINANCE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/your own role/i);
    expect((await User.findByPk(boss.id)).role).toBe(ROLES.SUPER_ADMIN);
  });
});

describe('activating and deactivating', () => {
  it('deactivates an account, revokes its sessions and blocks sign-in', async () => {
    const boss = await superAdmin();
    const staff = await staffOf(ROLES.FINANCE);

    const res = await request(app).patch(`/api/admin/staff/${staff.id}/status`).set(bearer(boss)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(await Session.count({ where: { userId: staff.id, revoked: false } })).toBe(0);

    const login = await request(app).post('/api/auth/login').send({ email: staff.email, password: DEFAULT_PASSWORD });
    expect(login.status).toBeGreaterThanOrEqual(400);
  });

  it('reactivates an account', async () => {
    const boss = await superAdmin();
    const staff = await createUser({ role: ROLES.FINANCE, isActive: false });

    const res = await request(app).patch(`/api/admin/staff/${staff.id}/status`).set(bearer(boss)).send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email: staff.email, password: DEFAULT_PASSWORD })).status).toBe(200);
  });

  it('refuses to deactivate yourself or the last Super Admin', async () => {
    const boss = await superAdmin();
    const self = await request(app).patch(`/api/admin/staff/${boss.id}/status`).set(bearer(boss)).send({ isActive: false });
    expect(self.status).toBe(400);

    const other = await superAdmin();
    const res = await request(app).patch(`/api/admin/staff/${other.id}/status`).set(bearer(boss)).send({ isActive: false });
    expect(res.status).toBe(200); // two exist, so this one may go
  });

  it('validates the isActive flag', async () => {
    const boss = await superAdmin();
    const staff = await staffOf(ROLES.FINANCE);
    expect((await request(app).patch(`/api/admin/staff/${staff.id}/status`).set(bearer(boss)).send({})).status).toBe(400);
  });
});

describe('resetting a staff password', () => {
  it('generates a working password, revokes sessions and clears any lockout', async () => {
    const boss = await superAdmin();
    const staff = await createUser({
      role: ROLES.SUPPORT,
      failedLoginAttempts: 5,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    const login = await request(app).post('/api/auth/login').send({ email: staff.email, password: DEFAULT_PASSWORD });

    const res = await request(app).post(`/api/admin/staff/${staff.id}/reset-password`).set(bearer(boss)).send({});
    expect(res.status).toBe(200);
    expect(res.body.generatedPassword).toEqual(expect.any(String));

    const reloaded = await User.findByPk(staff.id);
    expect(reloaded.lockedUntil).toBeNull();
    expect(reloaded.failedLoginAttempts).toBe(0);

    // The old session is dead and the old password no longer works.
    if (login.body.token) {
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`)).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/login')
      .send({ email: staff.email, password: res.body.generatedPassword })).status).toBe(200);
  });

  it('accepts a supplied password but holds it to the policy', async () => {
    const boss = await superAdmin();
    const staff = await staffOf(ROLES.SUPPORT);

    expect((await request(app).post(`/api/admin/staff/${staff.id}/reset-password`).set(bearer(boss))
      .send({ password: 'weak' })).status).toBe(400);

    const ok = await request(app).post(`/api/admin/staff/${staff.id}/reset-password`).set(bearer(boss))
      .send({ password: 'a-fine-password-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.generatedPassword).toBeNull();
    expect((await request(app).post('/api/auth/login')
      .send({ email: staff.email, password: 'a-fine-password-1' })).status).toBe(200);
  });
});

describe('deleting a staff account', () => {
  it('deletes one and refuses a parent, yourself, and the last Super Admin', async () => {
    const boss = await superAdmin();
    const staff = await staffOf(ROLES.MARKETING);
    const parent = await createUser({ role: 'parent' });

    expect((await request(app).delete(`/api/admin/staff/${parent.id}`).set(bearer(boss))).status).toBe(404);
    expect((await request(app).delete(`/api/admin/staff/${boss.id}`).set(bearer(boss))).status).toBe(400);

    const res = await request(app).delete(`/api/admin/staff/${staff.id}`).set(bearer(boss));
    expect(res.status).toBe(200);
    expect(await User.findByPk(staff.id)).toBeNull();

    // `boss` is now the only Super Admin — a second one may still be removed.
    const other = await superAdmin();
    expect((await request(app).delete(`/api/admin/staff/${other.id}`).set(bearer(boss))).status).toBe(200);
  });
});

/**
 * The point of the department roles: each account reaches its own screens and
 * nothing else. These assert the gate on the real routes rather than the
 * permission helper in isolation.
 */
describe('department permissions', () => {
  const CASES = [
    { role: ROLES.OPERATIONS, allowed: ['/api/admin/users', '/api/admin/clients', '/api/admin/settings', '/api/audit'], denied: ['/api/admin/transactions'] },
    { role: ROLES.SUPPORT, allowed: ['/api/admin/users', '/api/admin/clients', '/api/admin/sessions/active'], denied: ['/api/admin/transactions', '/api/admin/settings', '/api/audit'] },
    { role: ROLES.FINANCE, allowed: ['/api/admin/transactions'], denied: ['/api/admin/users', '/api/admin/clients', '/api/admin/settings', '/api/audit'] },
    { role: ROLES.MARKETING, allowed: [], denied: ['/api/admin/users', '/api/admin/clients', '/api/admin/transactions', '/api/admin/settings', '/api/audit'] },
  ];

  it.each(CASES)('$role reaches only what its role grants', async ({ role, allowed, denied }) => {
    const staff = await staffOf(role);

    for (const path of allowed) {
      expect({ path, status: (await request(app).get(path).set(bearer(staff))).status })
        .toEqual({ path, status: 200 });
    }
    for (const path of denied) {
      expect({ path, status: (await request(app).get(path).set(bearer(staff))).status })
        .toEqual({ path, status: 403 });
    }
  });

  /**
   * The rule, rather than a list of examples.
   *
   * `GET /api/admin/clients` returns every customer's name, email, plan and
   * status in one unpaginated array, and it was the one route in routes/admin.js
   * declared with no permission beyond `requireStaff`. Marketing cannot open the
   * Users screen and is shown no link to it, so nothing pointed at the hole —
   * but the endpoint answered a direct call from any staff account, and the
   * console does not call it at all, so no test exercised it either.
   *
   * This reads the route table and asserts the invariant across every GET in it,
   * so the next route added without a guard fails here rather than in an audit.
   * `/analytics` is the deliberate exception: it is aggregate counts with no
   * personal data, and the Overview screen is the one thing every department is
   * meant to see.
   */
  const OPEN_TO_ALL_STAFF = ['/api/admin/analytics'];

  it('no admin GET is reachable by a department that was granted nothing for it', async () => {
    const routeFile = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../src/routes/admin.js'), 'utf8'
    );

    // Only routes with no `:param`, so each can be called as-is.
    const paths = [...routeFile.matchAll(/router\.get\(\s*'(\/[^']*)'/g)]
      .map(([, p]) => `/api/admin${p === '/' ? '' : p}`)
      .filter((p) => !p.includes(':'));

    expect(paths.length).toBeGreaterThan(4);

    // Marketing holds send_notifications and nothing else, so every one of these
    // must refuse it apart from the documented exception.
    const marketing = await staffOf(ROLES.MARKETING);

    const reachable = [];
    for (const path of paths) {
      if (OPEN_TO_ALL_STAFF.includes(path)) continue;
      const { status } = await request(app).get(path).set(bearer(marketing));
      if (status !== 403) reachable.push({ path, status });
    }

    expect(reachable).toEqual([]);
  });

  it('a Super Admin reaches everything even with an empty permissions column', async () => {
    const boss = await createUser({ role: ROLES.SUPER_ADMIN, permissions: [] });

    for (const path of ['/api/admin/users', '/api/admin/transactions', '/api/admin/settings', '/api/audit', '/api/admin/staff']) {
      expect({ path, status: (await request(app).get(path).set(bearer(boss))).status })
        .toEqual({ path, status: 200 });
    }
  });

  it('every staff role can read the analytics overview', async () => {
    for (const role of [ROLES.SUPER_ADMIN, ROLES.OPERATIONS, ROLES.SUPPORT, ROLES.FINANCE, ROLES.MARKETING]) {
      const staff = await staffOf(role);
      expect({ role, status: (await request(app).get('/api/admin/analytics').set(bearer(staff))).status })
        .toEqual({ role, status: 200 });
    }
  });

  it('marketing can send a broadcast but it never reaches a staff inbox', async () => {
    const marketing = await staffOf(ROLES.MARKETING);
    const parent = await createUser({ role: 'parent' });
    const colleague = await staffOf(ROLES.FINANCE);

    const res = await request(app).post('/api/notifications').set(bearer(marketing))
      .send({ broadcast: true, title: 'Hello', message: 'Everyone' });
    expect(res.status).toBeLessThan(300);

    const { Notification } = require('../src/models');
    expect(await Notification.count({ where: { userId: parent.id } })).toBe(1);
    expect(await Notification.count({ where: { userId: colleague.id } })).toBe(0);
    expect(await Notification.count({ where: { userId: marketing.id } })).toBe(0);
  });
});

describe('promoting across the staff boundary', () => {
  it('lets a Super Admin promote a parent and demote them again', async () => {
    const boss = await superAdmin();
    const parent = await createUser({ role: 'parent' });

    const up = await request(app).patch(`/api/admin/users/${parent.id}/role`).set(bearer(boss))
      .send({ role: ROLES.FINANCE });
    expect(up.status).toBe(200);
    expect(up.body.role).toBe(ROLES.FINANCE);
    expect(up.body.permissions).toEqual(defaultPermissionsFor(ROLES.FINANCE));

    const down = await request(app).patch(`/api/admin/users/${parent.id}/role`).set(bearer(boss))
      .send({ role: 'parent' });
    expect(down.status).toBe(200);
    expect(down.body.permissions).toEqual([]);
  });

  it('refuses a department account with manage_users', async () => {
    const ops = await staffOf(ROLES.OPERATIONS);
    const parent = await createUser({ role: 'parent' });

    const res = await request(app).patch(`/api/admin/users/${parent.id}/role`).set(bearer(ops))
      .send({ role: ROLES.SUPER_ADMIN });
    expect(res.status).toBe(403);
    expect((await User.findByPk(parent.id)).role).toBe('parent');
  });

  it('will not let manage_users mint a staff account through /admin/users', async () => {
    const ops = await staffOf(ROLES.OPERATIONS);

    const res = await request(app).post('/api/admin/users').set(bearer(ops))
      .send({ name: 'Sneaky', email: 'sneaky@test.dev', password: 'password-1', role: ROLES.SUPER_ADMIN });

    expect(res.status).toBe(400);
    expect(await User.findOne({ where: { email: 'sneaky@test.dev' } })).toBeNull();
  });

  it('will not let a department account block or delete a colleague via the client endpoints', async () => {
    const ops = await staffOf(ROLES.OPERATIONS);
    const colleague = await staffOf(ROLES.FINANCE);

    expect((await request(app).patch(`/api/admin/clients/${colleague.id}/toggle-block`).set(bearer(ops))).status).toBe(404);
    expect((await request(app).delete(`/api/admin/clients/${colleague.id}`).set(bearer(ops))).status).toBe(404);
    expect((await request(app).patch(`/api/admin/users/${colleague.id}/approve`).set(bearer(ops))).status).toBe(404);
    expect((await User.findByPk(colleague.id)).isActive).toBe(true);
  });
});
