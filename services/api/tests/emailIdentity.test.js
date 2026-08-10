/**
 * An email address identifies an account, so the casing someone happens to type
 * must never decide whether they can reach it. Postgres compares strings
 * case-sensitively, so every one of these passed on SQLite while being broken in
 * production until the `email` setter and `User.findByEmail` were introduced.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');
const { ROLES } = require('../src/config/roles');

describe('email identity is case-insensitive', () => {
  it('stores a registered address in canonical form', async () => {
    await request(app).post('/api/auth/register')
      .send({ name: 'Case Test', email: '  Mixed.Case@Example.COM ', password: 'password123' })
      .expect(201);

    const user = await User.findByEmail('mixed.case@example.com');
    expect(user).not.toBeNull();
    expect(user.email).toBe('mixed.case@example.com');
  });

  it('lets a parent sign in with different capitalisation than they registered', async () => {
    await request(app).post('/api/auth/register')
      .send({ name: 'Case Test', email: 'Parent.Case@Example.COM', password: 'password123' })
      .expect(201);
    await (await User.findByEmail('parent.case@example.com')).update({ emailVerified: true });

    await request(app).post('/api/auth/login')
      .send({ email: 'parent.case@example.com', password: 'password123' })
      .expect(200);
  });

  it('refuses a registration that differs from an existing account only in case', async () => {
    await createUser({ email: 'dupe@example.com' });

    await request(app).post('/api/auth/register')
      .send({ name: 'Dupe', email: 'DUPE@Example.com', password: 'password123' })
      .expect(409);
  });

  it('lets a staff account sign in with the address the Super Admin typed', async () => {
    const superAdmin = await createUser({ role: ROLES.SUPER_ADMIN });
    const created = await request(app).post('/api/admin/staff')
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
      .send({ name: 'Support Person', email: 'Support.Person@Parentix.CA', role: ROLES.SUPPORT })
      .expect(201);

    await request(app).post('/api/auth/login')
      .send({ email: 'Support.Person@Parentix.CA', password: created.body.generatedPassword })
      .expect(200);
  });

  it('finds an account for password reset regardless of casing', async () => {
    const user = await createUser({ email: 'forgetful@example.com' });

    await request(app).post('/api/auth/forgot-password')
      .send({ email: 'Forgetful@Example.com' })
      .expect(200);

    await user.reload();
    expect(user.passwordResetToken).toBeTruthy();
  });

  it('treats re-saving your own address in a different case as a no-op, not a clash', async () => {
    const user = await createUser({ email: 'selfedit@example.com' });

    await request(app).put('/api/auth/profile')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ email: 'SelfEdit@Example.com' })
      .expect(200);
  });

  it('still rejects an address that belongs to somebody else', async () => {
    const user = await createUser({ email: 'mine@example.com' });
    await createUser({ email: 'theirs@example.com' });

    await request(app).put('/api/auth/profile')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ email: 'Theirs@Example.com' })
      .expect(409);
  });

  it('normalises an admin-created customer account too', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });

    const res = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ name: 'Managed', email: 'Managed.Client@Example.COM', password: 'password123' })
      .expect(201);

    expect(res.body.email).toBe('managed.client@example.com');
  });
});
