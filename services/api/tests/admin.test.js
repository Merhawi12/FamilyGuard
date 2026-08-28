const request = require('supertest');
const { app } = require('../src/app');
const { User, Session } = require('../src/models');
const { createUser, tokenFor, signIn, DEFAULT_PASSWORD } = require('./helpers');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

describe('Admin access control (requireRole + requirePermission)', () => {
  it('401 without a token', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('403 for a regular parent', async () => {
    const parent = await createUser({ role: 'parent' });
    const res = await request(app).get('/api/admin/users').set(bearer(parent));
    expect(res.status).toBe(403);
  });

  it('403 for a support user lacking manage_users', async () => {
    const support = await createUser({ role: 'support', permissions: ['manage_billing'] });
    const res = await request(app).get('/api/admin/users').set(bearer(support));
    expect(res.status).toBe(403);
  });

  it('200 for a support user with manage_users, and for a super admin', async () => {
    const support = await createUser({ role: 'support', permissions: ['manage_users'] });
    const admin = await createUser({ role: 'super_admin' });
    expect((await request(app).get('/api/admin/users').set(bearer(support))).status).toBe(200);
    expect((await request(app).get('/api/admin/users').set(bearer(admin))).status).toBe(200);
  });
});

describe('Admin user management', () => {
  it('creates a user with a hashed password; rejects duplicates and missing fields', async () => {
    const admin = await createUser({ role: 'super_admin' });

    const missing = await request(app).post('/api/admin/users').set(bearer(admin)).send({ email: 'x@y.dev' });
    expect(missing.status).toBe(400);

    const created = await request(app)
      .post('/api/admin/users').set(bearer(admin))
      .send({ name: 'Created', email: 'created@test.dev', password: 'adminmade1', plan: 'premium' });
    expect(created.status).toBe(201);
    const inDb = await User.findByPk(created.body.id);
    expect(inDb.passwordHash).not.toBe('adminmade1');
    expect(await inDb.comparePassword('adminmade1')).toBe(true);

    const dup = await request(app)
      .post('/api/admin/users').set(bearer(admin))
      .send({ name: 'Dup', email: 'created@test.dev', password: 'whatever1' });
    expect(dup.status).toBe(409);
  });

  it('approveUser verifies + activates the account', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const target = await createUser({ emailVerified: false, isActive: false });

    const res = await request(app).patch(`/api/admin/users/${target.id}/approve`).set(bearer(admin));
    expect(res.status).toBe(200);
    const reloaded = await User.findByPk(target.id);
    expect(reloaded.emailVerified).toBe(true);
    expect(reloaded.isActive).toBe(true);
  });

  it('toggleBlock flips isActive and revokes sessions when blocking', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const client = await createUser({ role: 'parent' });
    // Give the client a live session.
    const login = await signIn(client.email);
    expect(login.body.token).toBeTruthy();

    const block = await request(app).patch(`/api/admin/clients/${client.id}/toggle-block`).set(bearer(admin));
    expect(block.status).toBe(200);
    expect(block.body.isActive).toBe(false);

    const openSessions = await Session.count({ where: { userId: client.id, revoked: false } });
    expect(openSessions).toBe(0);
  });

  it('updatePlan validates the plan and syncs isActive', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const client = await createUser({ role: 'parent' });

    const bad = await request(app).patch(`/api/admin/clients/${client.id}/plan`).set(bearer(admin)).send({ plan: 'diamond' });
    expect(bad.status).toBe(400);

    const suspend = await request(app).patch(`/api/admin/clients/${client.id}/plan`).set(bearer(admin)).send({ plan: 'suspended' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.isActive).toBe(false);
  });

  it('will not delete/toggle a staff account via the client endpoints (404)', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const otherAdmin = await createUser({ role: 'super_admin' });

    const del = await request(app).delete(`/api/admin/clients/${otherAdmin.id}`).set(bearer(admin));
    expect(del.status).toBe(404);
    expect(await User.findByPk(otherAdmin.id)).toBeTruthy();
  });
});

describe('Admin sessions', () => {
  it('lists active sessions and force-logout-user revokes the token', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const user = await createUser({ role: 'parent' });
    const login = await signIn(user.email);
    const userToken = login.body.token;

    // The session-backed token works before revocation.
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${userToken}`)).status).toBe(200);

    // Paginated, so the payload is { rows, count }.
    const list = await request(app).get('/api/admin/sessions/active').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.count).toBeGreaterThanOrEqual(1);
    expect(list.body.rows.some((s) => s.userId === user.id)).toBe(true);

    const revoke = await request(app).delete(`/api/admin/users/${user.id}/sessions`).set(bearer(admin));
    expect(revoke.status).toBe(200);

    // After force-logout the same token is rejected.
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${userToken}`)).status).toBe(401);
  });
});

describe('Admin settings, analytics & billing', () => {
  it('gets defaults and persists updated settings', async () => {
    const admin = await createUser({ role: 'super_admin' });

    const before = await request(app).get('/api/admin/settings').set(bearer(admin));
    expect(before.status).toBe(200);
    expect(before.body).toHaveProperty('planFeatures');

    const upd = await request(app).put('/api/admin/settings').set(bearer(admin)).send({ maintenanceMode: true, defaultTrialDays: 14 });
    expect(upd.status).toBe(200);

    const after = await request(app).get('/api/admin/settings').set(bearer(admin));
    expect(after.body.maintenanceMode).toBe(true);
    expect(after.body.defaultTrialDays).toBe(14);
  });

  it('returns an analytics summary shape', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const res = await request(app).get('/api/admin/analytics').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalUsers');
    expect(Array.isArray(res.body.byPlan)).toBe(true);
    expect(res.body).toHaveProperty('totalRevenue');
  });

  it('lists transactions (permission-gated to manage_billing)', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const res = await request(app).get('/api/admin/transactions').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rows');

    const support = await createUser({ role: 'support', permissions: ['manage_users'] }); // no manage_billing
    const denied = await request(app).get('/api/admin/transactions').set(bearer(support));
    expect(denied.status).toBe(403);
  });
});
