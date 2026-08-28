/**
 * Sign in with Google — one endpoint that both registers and signs in.
 *
 * Google's verification is replaced rather than reached: the point of these is
 * what the controller does with a *verified* payload, not that Google's library
 * checks a signature. What is worth pinning is everything after that, because
 * each of these is an account-takeover route if it goes wrong:
 *
 *   - an unverified Google address must not be able to claim an existing account
 *   - a deactivated account must not be signed into
 *   - a second factor must not be skipped
 *   - a Google-only account must not be reachable with any password
 */
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { env } = require('../src/config/env');
const { createUser, DEFAULT_PASSWORD } = require('./helpers');

/** A payload shaped as Google's, verified. Overridable per test. */
const payload = (overrides = {}) => ({
  sub: '110000000000000000001',
  email: 'google.user@example.com',
  email_verified: true,
  name: 'Google User',
  aud: 'test-web-client.apps.googleusercontent.com',
  iss: 'https://accounts.google.com',
  ...overrides,
});

const googleReturns = (claims) => {
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => payload(claims) });
};

const signIn = (credential = 'a.google.idtoken') =>
  request(app).post('/api/auth/google').send({ credential });

const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

beforeEach(() => {
  mockVerifyIdToken.mockReset();
});

describe('the token is verified before anything else happens', () => {
  it('checks it against the configured audiences, not just any audience', async () => {
    googleReturns({});

    await signIn('some.token');

    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'some.token',
      audience: env.googleSignIn.audiences,
    });
    expect(env.googleSignIn.audiences.length).toBeGreaterThan(0);
  });

  it('refuses a token Google will not vouch for', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Invalid token signature'));

    const res = await signIn();

    expect(res.status).toBe(401);
    // The reason stays in the log — a caller learns only that it failed.
    expect(res.body.error).toBe('Google sign-in failed');
  });

  it('refuses a request with no credential', async () => {
    expect((await request(app).post('/api/auth/google').send({})).status).toBe(400);
  });

  it('refuses an address Google has not verified', async () => {
    // The account-takeover case: anyone can create a Google account claiming an
    // address, but only a verified one proves control of it. Without this check
    // the linking below would hand over somebody else's family.
    const victim = await createUser({ email: 'victim@example.com' });
    googleReturns({ email: 'victim@example.com', email_verified: false });

    const res = await signIn();

    expect(res.status).toBe(401);
    expect((await User.findByPk(victim.id)).googleId).toBeNull();
  });
});

describe('registering with Google', () => {
  it('creates a verified parent account with no password', async () => {
    googleReturns({ email: 'brand.new@example.com', sub: 'sub-new-1' });

    const res = await signIn();

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.token).toEqual(expect.any(String));

    const user = await User.findByEmail('brand.new@example.com');
    expect(user.googleId).toBe('sub-new-1');
    expect(user.emailVerified).toBe(true);
    expect(user.role).toBe('parent');
    // No password, and no placeholder standing in for one.
    expect(user.passwordHash).toBeNull();
    // The same seven-day trial a password registration gets.
    expect(new Date(user.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('cannot be signed into with any password at all', async () => {
    googleReturns({ email: 'passwordless@example.com', sub: 'sub-new-2' });
    await signIn();

    // bcrypt against a null hash used to throw, which would have been a 500 —
    // and a 500 here tells an attacker the address exists.
    for (const guess of ['', 'password123', 'null', DEFAULT_PASSWORD]) {
      const res = await login('passwordless@example.com', guess);
      expect([400, 401]).toContain(res.status);
    }
  });

  it('signs the same person in again without creating a second account', async () => {
    googleReturns({ email: 'returning@example.com', sub: 'sub-returning' });

    const first = await signIn();
    const second = await signIn();

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(await User.count({ where: { email: 'returning@example.com' } })).toBe(1);
  });

  it('falls back to the address when Google sends no name', async () => {
    googleReturns({ email: 'noname@example.com', sub: 'sub-noname', name: undefined });

    await signIn();

    expect((await User.findByEmail('noname@example.com')).name).toBe('noname');
  });

  it('stores the address lower-cased, however Google spells it', async () => {
    googleReturns({ email: 'MixedCase.User@Example.COM', sub: 'sub-mixed' });

    await signIn();

    expect(await User.findByEmail('mixedcase.user@example.com')).not.toBeNull();
  });
});

describe('linking Google to an account that already exists', () => {
  it('links on a verified address and leaves the password working', async () => {
    const existing = await createUser({ email: 'both.ways@example.com' });
    googleReturns({ email: 'both.ways@example.com', sub: 'sub-link-1' });

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);

    const linked = await User.findByPk(existing.id);
    expect(linked.googleId).toBe('sub-link-1');
    // Google proved control of the address, so an account stuck unverified is
    // verified by this.
    expect(linked.emailVerified).toBe(true);

    // Both routes into the account still work — linking adds a way in, it does
    // not replace one.
    expect((await login('both.ways@example.com', DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('finds a linked account by subject even after the address changes', async () => {
    googleReturns({ email: 'old.address@example.com', sub: 'sub-stable' });
    await signIn();
    const created = await User.findByEmail('old.address@example.com');

    // Google accounts can change their address; `sub` cannot change.
    googleReturns({ email: 'new.address@example.com', sub: 'sub-stable' });
    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(created.id);
    expect(await User.count({ where: { googleId: 'sub-stable' } })).toBe(1);
  });

  it('refuses a second Google identity claiming an already-linked account', async () => {
    const user = await createUser({ email: 'already.linked@example.com' });
    await user.update({ googleId: 'sub-first-owner' });

    googleReturns({ email: 'already.linked@example.com', sub: 'sub-impostor' });
    const res = await signIn();

    expect(res.status).toBe(409);
    expect((await User.findByPk(user.id)).googleId).toBe('sub-first-owner');
  });
});

describe('Google sign-in obeys the same account rules as a password sign-in', () => {
  it('refuses a deactivated account', async () => {
    await createUser({ email: 'deactivated@example.com', isActive: false });
    googleReturns({ email: 'deactivated@example.com', sub: 'sub-inactive' });

    const res = await signIn();

    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });

  it('still demands the second factor when MFA is on', async () => {
    await createUser({ email: 'mfa.user@example.com', mfaEnabled: true, mfaSecret: 'SECRET' });
    googleReturns({ email: 'mfa.user@example.com', sub: 'sub-mfa' });

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.preAuthToken).toEqual(expect.any(String));
    // Crucially, not a session.
    expect(res.body.token).toBeUndefined();
  });

  it('clears a failed-login lockout, the way a successful password login does', async () => {
    const user = await createUser({
      email: 'locked.out@example.com',
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    googleReturns({ email: 'locked.out@example.com', sub: 'sub-locked' });

    expect((await signIn()).status).toBe(200);

    const reloaded = await User.findByPk(user.id);
    expect(reloaded.lockedUntil).toBeNull();
    expect(reloaded.failedLoginAttempts).toBe(0);
  });

  it('never returns the password hash or the Google subject to the browser', async () => {
    const existing = await createUser({ email: 'leak.check@example.com' });
    googleReturns({ email: 'leak.check@example.com', sub: 'sub-leak' });

    const res = await signIn();

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('sub-leak');
    expect(body).not.toContain(existing.passwordHash);
    expect(res.body.user.passwordHash).toBeUndefined();
  });
});

describe('what the sign-in page is told', () => {
  it('advertises Google when a client ID is configured', async () => {
    const res = await request(app).get('/api/auth/providers');

    expect(res.status).toBe(200);
    // `maintenance` joined this payload when the console's maintenance toggle
    // was made real — the sign-in page has to know before anyone types a
    // password. `billing` joined it so a deployment with no Stripe key does not
    // draw an Upgrade button; it reads true here because env.setup.js pins a
    // dummy key to make the mocked Stripe client non-null. Both halves are
    // asserted against real configuration in billingAvailability.test.js.
    //
    // Still an exact match, so a field cannot appear here unnoticed — which is
    // how both of those arrived deliberately rather than by accident.
    // `loginCode` joined it when the emailed second factor did, for the same
    // reason as `maintenance`: the sign-in screen has to be able to say what is
    // about to happen before anyone types a password, and an operator who has
    // switched the factor off during a mail outage has to be able to see that
    // from outside the container.
    expect(res.body).toEqual({
      password: true, google: true, phone: false, maintenance: false, billing: true,
      loginCode: true,
    });
  });

  /**
   * The sign-in screen draws its Phone tab from this, exactly as the Google
   * button draws itself from the line above. A deployment with no SMS
   * credentials answers `requestPhoneCode` with a successful 200 and
   * `smsDelivered: false`, so without this the parent is walked to a code
   * screen to wait for a message that was never going to be sent.
   */
  it('does not advertise phone sign-in when no SMS provider is configured', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.body.phone).toBe(false);
  });

  it('advertises phone sign-in once an SMS provider is configured', async () => {
    const { sms } = env;
    const saved = { provider: sms.provider, accountSid: sms.accountSid, authToken: sms.authToken, from: sms.from };
    Object.assign(sms, { provider: 'twilio', accountSid: 'AC-test', authToken: 'tok', from: '+15550000000' });
    try {
      const res = await request(app).get('/api/auth/providers');
      expect(res.body.phone).toBe(true);
    } finally {
      Object.assign(sms, saved);
    }
  });

  it('reports the feature unavailable, and refuses, when nothing is configured', async () => {
    // `env` is frozen only at the top level, so the audience list can be emptied
    // for the length of one assertion — which is the only way to reach the
    // unconfigured branch without a second module registry.
    const audiences = env.googleSignIn.audiences;
    const saved = audiences.splice(0, audiences.length);
    try {
      expect((await request(app).get('/api/auth/providers')).body.google).toBe(false);

      const res = await signIn();
      expect(res.status).toBe(503);
      // Never 500: an unconfigured optional feature is not a fault.
      expect(res.body.error).toMatch(/not configured/i);
    } finally {
      audiences.push(...saved);
    }
  });
});
