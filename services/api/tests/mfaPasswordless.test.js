/**
 * An account with no password must still be able to turn MFA off.
 *
 * Google and phone sign-up both create a user with `password_hash` null, and
 * `comparePassword` answers false for one rather than throwing. `disable`
 * demanded a password and compared it, so for those accounts every attempt
 * answered "Invalid password" — MFA became a one-way door, and the only way back
 * out was a staff password reset.
 *
 * This is the same defect `changePassword` was already fixed for; see the
 * `settingFirstPassword` branch there for the reasoning about why a live session
 * is the right standard when there is no password to re-check.
 */
const request = require('supertest');
const { verify } = require('otplib'); // manual mock — verify() is a jest.fn
const { app } = require('../src/app');
const { User } = require('../src/models');
const { createUser, tokenFor, DEFAULT_PASSWORD } = require('./helpers');

const authHeader = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

/**
 * Reset the implementation, not just the call log.
 *
 * `mockClear` leaves a queued `mockResolvedValueOnce` in place. A test whose
 * request is refused *before* the controller reaches `verify` therefore leaves
 * its queued value behind for whichever later test calls it first — which is how
 * a wrong-code case and a right-code case one describe block apart end up
 * sharing an answer.
 */
beforeEach(() => {
  verify.mockReset();
  verify.mockImplementation(async ({ token }) => {
    if (!/^\d{6}$/.test(String(token))) {
      throw new Error(`Token must be 6 digits, got ${String(token).length}`);
    }
    return { valid: true };
  });
});

/** A Google account: verified, linked by `sub`, and with no password at all. */
const passwordlessUser = (overrides = {}) =>
  createUser({
    passwordHash: null,
    googleId: `google-sub-${Math.random().toString(16).slice(2)}`,
    ...overrides,
  });

describe('MFA disable — accounts with no password', () => {
  it('lets a Google account with MFA on turn it off with just the TOTP code', async () => {
    const user = await passwordlessUser({ mfaEnabled: true, mfaSecret: 'TESTSECRET' });

    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader(user))
      .send({ code: '123456' });

    expect(res.status).toBe(200);
    const reloaded = await User.findByPk(user.id);
    expect(reloaded.mfaEnabled).toBe(false);
    expect(reloaded.mfaSecret).toBeNull();
  });

  it('still refuses a wrong TOTP code on a passwordless account', async () => {
    const user = await passwordlessUser({ mfaEnabled: true, mfaSecret: 'TESTSECRET' });

    verify.mockResolvedValueOnce({ valid: false });
    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader(user))
      .send({ code: '000000' });

    expect(res.status).toBe(400);
    expect((await User.findByPk(user.id)).mfaEnabled).toBe(true);
  });

  it('a phone-only account can also turn MFA off', async () => {
    const user = await createUser({
      email: null,
      passwordHash: null,
      phone: '+14155550123',
      phoneVerified: true,
      mfaEnabled: true,
      mfaSecret: 'TESTSECRET',
    });

    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader(user))
      .send({ code: '123456' });

    expect(res.status).toBe(200);
  });
});

describe('MFA disable — accounts that do have a password', () => {
  it('still requires the password, so a borrowed session cannot drop the second factor', async () => {
    const user = await createUser({ mfaEnabled: true, mfaSecret: 'TESTSECRET' });

    const noPassword = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader(user))
      .send({ code: '123456' });
    expect(noPassword.status).toBe(400);

    const wrongPassword = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader(user))
      .send({ code: '123456', password: 'not-the-password' });
    expect(wrongPassword.status).toBe(401);

    expect((await User.findByPk(user.id)).mfaEnabled).toBe(true);

    const ok = await request(app)
      .post('/api/auth/mfa/disable')
      .set(authHeader(user))
      .send({ code: '123456', password: DEFAULT_PASSWORD });
    expect(ok.status).toBe(200);
  });
});

describe('MFA setup — accounts with no email address', () => {
  it('labels the authenticator entry without printing "null"', async () => {
    const user = await createUser({
      email: null,
      passwordHash: null,
      phone: '+14155550124',
      phoneVerified: true,
    });

    const res = await request(app).post('/api/auth/mfa/setup').set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.otpauth).not.toMatch(/null/);
  });
});
