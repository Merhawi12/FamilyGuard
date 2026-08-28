const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const {
  createUser, tokenFor, uniqueEmail, signIn, DEFAULT_PASSWORD, seedResetCode,
} = require('./helpers');

describe('Auth', () => {
  describe('POST /api/auth/register', () => {
    it('rejects missing fields with 400', async () => {
      const res = await request(app).post('/api/auth/register').send({ email: 'a@b.dev' });
      expect(res.status).toBe(400);
    });

    it('creates a user and stores the password hashed (never plaintext)', async () => {
      const email = uniqueEmail('reg');
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Reg', email, password: 'secretpw123' });

      expect(res.status).toBe(201);
      expect(res.body.email).toBe(email);
      expect(res.body.token).toBeUndefined(); // no token until email verified

      const user = await User.findOne({ where: { email } });
      expect(user).toBeTruthy();
      expect(user.passwordHash).not.toBe('secretpw123');
      expect(await user.comparePassword('secretpw123')).toBe(true);
      expect(user.emailVerified).toBe(false);
    });

    it('rejects a duplicate email with 409', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Dup', email: user.email, password: 'whatever123' });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/auth/login', () => {
    it('rejects missing credentials with 400', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'a@b.dev' });
      expect(res.status).toBe(400);
    });

    it('rejects wrong password with 401 and no token', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'wrongpassword' });
      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
    });

    it('blocks an unverified account with 403', async () => {
      const user = await createUser({ emailVerified: false });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: DEFAULT_PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.emailVerificationRequired).toBe(true);
    });

    it('answers a correct password with a challenge, not a session', async () => {
      // The password is the first factor now, not the whole of it. What comes
      // back is a five-minute ticket and the masked address the code went to;
      // `loginCode.test.js` covers the rest of that flow.
      const user = await createUser();
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: DEFAULT_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.loginCodeRequired).toBe(true);
      expect(res.body.token).toBeUndefined();
    });

    it('logs in a verified user and returns a token', async () => {
      const user = await createUser();
      const res = await signIn(user.email);
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user.email).toBe(user.email);
      expect(res.body.user.passwordHash).toBeUndefined(); // serialized, no secrets
    });

    it('locks the account after repeated failures (423)', async () => {
      const user = await createUser();
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' });
      }
      // Even the correct password is now refused because the account is locked.
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: DEFAULT_PASSWORD });
      expect(res.status).toBe(423);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns the current user with a valid token', async () => {
      const user = await createUser();
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenFor(user)}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(user.id);
    });
  });

  describe('Password reset', () => {
    it('forgot-password always returns 200 (no account enumeration)', async () => {
      const existing = await createUser();
      const a = await request(app).post('/api/auth/forgot-password').send({ email: existing.email });
      const b = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@nowhere.dev' });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.message).toBe(b.body.message);
    });

    it('rejects an invalid reset token with 400', async () => {
      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'bogus', newPassword: 'newpassword1' });
      expect(res.status).toBe(400);
    });

    it('mails a code rather than a link, and issues no ticket until it comes back', async () => {
      const user = await createUser();

      await request(app).post('/api/auth/forgot-password').send({ email: user.email }).expect(200);

      const reloaded = await User.findByPk(user.id);
      expect(reloaded.passwordResetCode).toBeTruthy();
      expect(reloaded.passwordResetToken).toBeNull();
    });

    it('resets the password once the code has been presented, and clears any lock', async () => {
      const user = await createUser();

      const code = await seedResetCode(user);
      const verified = await request(app)
        .post('/api/auth/verify-reset-code')
        .send({ email: user.email, code });
      expect(verified.status).toBe(200);

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: verified.body.resetToken, newPassword: 'brandnewpw1' });
      expect(res.status).toBe(200);

      const after = await User.findByPk(user.id);
      expect(await after.comparePassword('brandnewpw1')).toBe(true);
      expect(after.passwordResetToken).toBeNull();
      expect(after.passwordResetCode).toBeNull();
    });
  });
});
