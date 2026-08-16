const request = require('supertest');
const { app } = require('../src/app');
const { User, Session } = require('../src/models');
const { createUser, tokenFor, uniqueEmail, DEFAULT_PASSWORD, seedResetCode } = require('./helpers');

/** Walks the reset flow as far as the ticket the last step spends. */
const resetTicketFor = async (user) => {
  const code = await seedResetCode(user);
  const res = await request(app).post('/api/auth/verify-reset-code').send({ email: user.email, code });
  return res.body.resetToken;
};

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

    /**
     * The code registration issued cannot be read back — the column holds a
     * keyed hash — so a known one is put in its place. What this test is about
     * is the session the endpoint issues, not the digits that reach it;
     * `emailDelivery.test.js` is where the issued code is followed into a
     * message.
     */
    const user = await User.findOne({ where: { email } });
    await user.update({ emailVerificationCode: '246813' });

    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email, code: '246813' });

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

    // The code goes to the address; the ticket that authorises the change comes
    // back from `verify-reset-code`. The full flow is covered in
    // passwordResetFlow.test.js — here it is only the way in.
    const token = await resetTicketFor(user);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'brand-new-pass1' });

    expect(res.status).toBe(200);
    await first.reload();
    await second.reload();
    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(true);
  });

  it('enforces the password policy on the new password', async () => {
    const user = await createUser();

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: await resetTicketFor(user), newPassword: 'weak' });

    expect(res.status).toBe(400);
  });
});
