const request = require('supertest');
const { authenticator } = require('otplib'); // manual mock — verify() is a jest.fn
const { app } = require('../src/app');
const { User } = require('../src/models');
const { createUser, tokenFor, DEFAULT_PASSWORD } = require('./helpers');

const authHeader = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

describe('MFA setup & enable', () => {
  it('setup stores an unconfirmed secret and returns a QR', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/mfa/setup').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
    expect(res.body.qrCode).toMatch(/^data:image\/png/);
    const reloaded = await User.findByPk(user.id);
    expect(reloaded.mfaSecret).toBeTruthy();
    expect(reloaded.mfaEnabled).toBe(false);
  });

  it('enable rejects a bad TOTP code (400) and activates on a good one (returns backup codes)', async () => {
    const user = await createUser({ mfaSecret: 'TESTSECRET' });

    authenticator.verify.mockReturnValueOnce(false);
    const bad = await request(app).post('/api/auth/mfa/enable').set(authHeader(user)).send({ code: '000000' });
    expect(bad.status).toBe(400);

    const good = await request(app).post('/api/auth/mfa/enable').set(authHeader(user)).send({ code: '123456' });
    expect(good.status).toBe(200);
    expect(Array.isArray(good.body.backupCodes)).toBe(true);
    expect(good.body.backupCodes).toHaveLength(8);

    const reloaded = await User.findByPk(user.id);
    expect(reloaded.mfaEnabled).toBe(true);
  });
});

describe('MFA login (two-step)', () => {
  it('login returns a pre-auth challenge, and validate exchanges it for a full token', async () => {
    const user = await createUser({ mfaEnabled: true, mfaSecret: 'TESTSECRET' });

    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.token).toBeUndefined(); // no full token yet
    expect(typeof login.body.preAuthToken).toBe('string');

    const validated = await request(app)
      .post('/api/auth/mfa/validate')
      .send({ preAuthToken: login.body.preAuthToken, code: '123456' });
    expect(validated.status).toBe(200);
    expect(typeof validated.body.token).toBe('string');

    // The issued token works on an authenticated route.
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${validated.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);
  });

  it('rejects validate with an invalid TOTP and no matching backup code (401)', async () => {
    const user = await createUser({ mfaEnabled: true, mfaSecret: 'TESTSECRET', mfaBackupCodes: JSON.stringify([]) });
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });

    authenticator.verify.mockReturnValueOnce(false);
    const res = await request(app)
      .post('/api/auth/mfa/validate')
      .send({ preAuthToken: login.body.preAuthToken, code: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts a one-time backup code when TOTP fails, and burns it (second use → 401)', async () => {
    // Enable MFA properly to obtain real (hashed) backup codes.
    const user = await createUser({ mfaSecret: 'TESTSECRET' });
    const enabled = await request(app).post('/api/auth/mfa/enable').set(authHeader(user)).send({ code: '123456' });
    const backupCode = enabled.body.backupCodes[0];

    const login1 = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    authenticator.verify.mockReturnValueOnce(false); // force the backup-code path
    const first = await request(app)
      .post('/api/auth/mfa/validate')
      .send({ preAuthToken: login1.body.preAuthToken, code: backupCode });
    expect(first.status).toBe(200);
    expect(typeof first.body.token).toBe('string');

    // Reusing the same backup code must fail — it was consumed.
    const login2 = await request(app).post('/api/auth/login').send({ email: user.email, password: DEFAULT_PASSWORD });
    authenticator.verify.mockReturnValueOnce(false);
    const second = await request(app)
      .post('/api/auth/mfa/validate')
      .send({ preAuthToken: login2.body.preAuthToken, code: backupCode });
    expect(second.status).toBe(401);
  });
});
