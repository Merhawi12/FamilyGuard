const request = require('supertest');
const { app } = require('../src/app');
const { User, Session, AuditLog } = require('../src/models');
const { createUser, tokenFor, DEFAULT_PASSWORD } = require('./helpers');
const { ROLES, PERMISSIONS, defaultPermissionsFor } = require('../src/config/roles');

const bearer = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const staffOf = (role) => createUser({ role, permissions: defaultPermissionsFor(role) });

/**
 * An admin setting a customer's password is an account takeover, so it is gated
 * on its own permission — `manage_users` alone must not be enough — and it is
 * always written to the audit log.
 */
describe('resetting a customer password', () => {
  it('assigns a specific password chosen by the admin', async () => {
    const staff = await staffOf(ROLES.SUPPORT);
    const customer = await createUser({ role: 'parent' });

    const res = await request(app)
      .post(`/api/admin/users/${customer.id}/reset-password`)
      .set(bearer(staff))
      .send({ password: 'assigned-pass-1' });

    expect(res.status).toBe(200);
    expect(res.body.generatedPassword).toBeNull();

    expect((await request(app).post('/api/auth/login')
      .send({ email: customer.email, password: 'assigned-pass-1' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login')
      .send({ email: customer.email, password: DEFAULT_PASSWORD })).status).toBe(401);
  });

  it('generates one when none is supplied, and returns it exactly once', async () => {
    const staff = await staffOf(ROLES.SUPPORT);
    const customer = await createUser({ role: 'parent' });

    const res = await request(app)
      .post(`/api/admin/users/${customer.id}/reset-password`)
      .set(bearer(staff))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.generatedPassword).toEqual(expect.any(String));
    expect((await request(app).post('/api/auth/login')
      .send({ email: customer.email, password: res.body.generatedPassword })).status).toBe(200);

    // It is hashed from here on — nothing echoes it back.
    const reloaded = await User.findByPk(customer.id);
    expect(reloaded.passwordHash).not.toBe(res.body.generatedPassword);
  });

  it('holds a supplied password to the policy', async () => {
    const staff = await staffOf(ROLES.SUPPORT);
    const customer = await createUser({ role: 'parent' });
    const post = (password) => request(app)
      .post(`/api/admin/users/${customer.id}/reset-password`).set(bearer(staff)).send({ password });

    expect((await post('short1')).status).toBe(400);
    expect((await post('nodigitshereatall')).status).toBe(400);
    // The original password still works after a rejected attempt.
    expect((await request(app).post('/api/auth/login')
      .send({ email: customer.email, password: DEFAULT_PASSWORD })).status).toBe(200);
  });

  it('revokes every live session and clears a lockout', async () => {
    const staff = await staffOf(ROLES.SUPPORT);
    const customer = await createUser({
      role: 'parent',
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    // A locked account cannot log in, so seed a session directly.
    await Session.create({ userId: customer.id });

    const res = await request(app)
      .post(`/api/admin/users/${customer.id}/reset-password`).set(bearer(staff)).send({});
    expect(res.status).toBe(200);

    expect(await Session.count({ where: { userId: customer.id, revoked: false } })).toBe(0);
    const reloaded = await User.findByPk(customer.id);
    expect(reloaded.lockedUntil).toBeNull();
    expect(reloaded.failedLoginAttempts).toBe(0);
  });

  it('writes an audit entry naming the actor and the account', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    const customer = await createUser({ role: 'parent' });

    await request(app).post(`/api/admin/users/${customer.id}/reset-password`).set(bearer(staff)).send({});

    const entry = await AuditLog.findOne({
      where: { action: 'admin.user_password_reset', entityId: customer.id },
    });
    expect(entry).toBeTruthy();
    expect(entry.userId).toBe(staff.id);
  });
});

describe('who may reset a customer password', () => {
  it('refuses an unauthenticated caller and a parent', async () => {
    const customer = await createUser({ role: 'parent' });
    const other = await createUser({ role: 'parent' });

    expect((await request(app).post(`/api/admin/users/${customer.id}/reset-password`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/admin/users/${customer.id}/reset-password`)
      .set(bearer(other)).send({})).status).toBe(403);
  });

  it.each([ROLES.FINANCE, ROLES.MARKETING])('refuses %s', async (role) => {
    const staff = await staffOf(role);
    const customer = await createUser({ role: 'parent' });

    const res = await request(app)
      .post(`/api/admin/users/${customer.id}/reset-password`).set(bearer(staff)).send({});

    expect(res.status).toBe(403);
    expect((await request(app).post('/api/auth/login')
      .send({ email: customer.email, password: DEFAULT_PASSWORD })).status).toBe(200);
  });

  it('refuses a staff account that has manage_users but not reset_passwords', async () => {
    const staff = await createUser({ role: ROLES.SUPPORT, permissions: [PERMISSIONS.MANAGE_USERS] });
    const customer = await createUser({ role: 'parent' });

    // It can edit the account…
    expect((await request(app).put(`/api/admin/users/${customer.id}`)
      .set(bearer(staff)).send({ name: 'Edited' })).status).toBe(200);
    // …but not seize it.
    expect((await request(app).post(`/api/admin/users/${customer.id}/reset-password`)
      .set(bearer(staff)).send({})).status).toBe(403);
  });

  it('will not touch a staff account — those go through /admin/staff', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    const colleague = await staffOf(ROLES.FINANCE);

    const res = await request(app)
      .post(`/api/admin/users/${colleague.id}/reset-password`).set(bearer(staff)).send({ password: 'takeover-1' });

    expect(res.status).toBe(404);
    expect((await request(app).post('/api/auth/login')
      .send({ email: colleague.email, password: DEFAULT_PASSWORD })).status).toBe(200);
  });

  it('lets a Super Admin do it regardless of the stored permissions column', async () => {
    const boss = await createUser({ role: ROLES.SUPER_ADMIN, permissions: [] });
    const customer = await createUser({ role: 'parent' });

    expect((await request(app).post(`/api/admin/users/${customer.id}/reset-password`)
      .set(bearer(boss)).send({})).status).toBe(200);
  });
});

describe('admin edits to a customer account are audited', () => {
  it('records a profile update', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    const customer = await createUser({ role: 'parent' });

    const res = await request(app).put(`/api/admin/users/${customer.id}`)
      .set(bearer(staff)).send({ name: 'New Name', plan: 'premium' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');

    const entry = await AuditLog.findOne({ where: { action: 'admin.user_updated', entityId: customer.id } });
    expect(entry).toBeTruthy();
    expect(entry.userId).toBe(staff.id);
  });

  it('refuses an email that another account already uses', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    const customer = await createUser({ role: 'parent' });
    const taken = await createUser({ role: 'parent' });

    const res = await request(app).put(`/api/admin/users/${customer.id}`)
      .set(bearer(staff)).send({ email: taken.email });

    expect(res.status).toBe(409);
  });
});

/** Every table the console renders has to page, or a busy platform stalls it. */
describe('pagination', () => {
  it('pages the user directory and reports the full count', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    for (let i = 0; i < 5; i += 1) await createUser({ role: 'parent' });

    const first = await request(app).get('/api/admin/users?limit=2&offset=0').set(bearer(staff));
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(2);
    expect(first.body.count).toBeGreaterThanOrEqual(6);

    const second = await request(app).get('/api/admin/users?limit=2&offset=2').set(bearer(staff));
    expect(second.body.rows).toHaveLength(2);
    // A different page really is different rows.
    expect(second.body.rows.map((r) => r.id)).not.toEqual(first.body.rows.map((r) => r.id));
    expect(second.body.count).toBe(first.body.count);
  });

  it('pages active sessions', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    const customer = await createUser({ role: 'parent' });
    for (let i = 0; i < 3; i += 1) await Session.create({ userId: customer.id });

    const res = await request(app).get('/api/admin/sessions/active?limit=2&offset=0').set(bearer(staff));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBeLessThanOrEqual(2);
    expect(res.body.count).toBeGreaterThanOrEqual(3);
  });

  it('pages the audit log', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    const customer = await createUser({ role: 'parent' });
    for (let i = 0; i < 3; i += 1) {
      await request(app).put(`/api/admin/users/${customer.id}`).set(bearer(staff)).send({ name: `N${i}` });
    }

    const res = await request(app).get('/api/audit?limit=2&offset=0').set(bearer(staff));
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(2);
    expect(res.body.count).toBeGreaterThanOrEqual(3);
  });

  it('pages sent notifications', async () => {
    const marketing = await staffOf(ROLES.MARKETING);
    await createUser({ role: 'parent' });
    await createUser({ role: 'parent' });
    await request(app).post('/api/notifications').set(bearer(marketing))
      .send({ broadcast: true, title: 'Hi', message: 'All' });

    const res = await request(app).get('/api/notifications/sent?limit=1&offset=0').set(bearer(marketing));

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
  });

  it('caps an oversized limit rather than dumping the table', async () => {
    const staff = await staffOf(ROLES.OPERATIONS);
    for (let i = 0; i < 3; i += 1) await createUser({ role: 'parent' });

    const res = await request(app).get('/api/admin/users?limit=100000').set(bearer(staff));
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(200);
  });
});
