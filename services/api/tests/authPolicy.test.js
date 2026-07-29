const request = require('supertest');
const { app } = require('../src/app');
const { User, Session } = require('../src/models');
const { createUser, tokenFor, uniqueEmail, DEFAULT_PASSWORD } = require('./helpers');

describe('password policy', () => {
  it.each([
    ['too short', 'Pw1'],
    ['no digit', 'passwordonly'],
    ['no letter', '1234567890'],
  ])('rejects a password that is %s at registration', async (_label, password) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New Parent', email: uniqueEmail('policy'), password });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('accepts a password that satisfies the policy', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New Parent', email: uniqueEmail('policy'), password: 'correct-horse9' });

    expect(res.status).toBe(201);
  });

  it('applies the same rule when changing a password', async () => {
    const user = await createUser();

    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'short1' });

    expect(res.status).toBe(400);
  });
});

describe('email verification', () => {
  it('issues a session-bound token so the session can be revoked later', async () => {
    const email = uniqueEmail('verify');
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Verify Me', email, password: 'correct-horse9' });

    const user = await User.findOne({ where: { email } });
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email, code: user.emailVerificationCode });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(email);

    // A Session row is what makes an admin force-logout able to kill this token.
    const sessions = await Session.findAll({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);

    // And the token really is accepted.
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);

    // Revoking that session locks the token out.
    await sessions[0].update({ revoked: true });
    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(after.status).toBe(401);
  });
});

describe('password reset', () => {
  it('revokes every existing session', async () => {
    const user = await createUser();

    // Two live sessions, as if the parent were signed in on two devices.
    const first = await Session.create({ userId: user.id });
    const second = await Session.create({ userId: user.id });

    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    await user.reload();
    expect(user.passwordResetToken).toBeTruthy();

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: user.passwordResetToken, newPassword: 'brand-new-pass1' });

    expect(res.status).toBe(200);
    await first.reload();
    await second.reload();
    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(true);
  });

  it('enforces the password policy on the new password', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    await user.reload();

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: user.passwordResetToken, newPassword: 'weak' });

    expect(res.status).toBe(400);
  });
});
