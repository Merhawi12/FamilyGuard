/**
 * Regressions for the 2026-08-09 (second pass) audit.
 *
 * Three defects and two missing notifications, all of them invisible to a suite
 * that was green at 614 checks. Each is pinned by the behaviour that was wrong
 * rather than by the shape of the fix, so a refactor that reintroduces the hole
 * fails here even if it keeps the new helper.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { Session } = require('../src/models');
const { createUser, uniqueEmail, DEFAULT_PASSWORD } = require('./helpers');

jest.mock('../src/services/sms', () => ({
  sendVerificationSms: jest.fn().mockResolvedValue(true),
  isEnabled: () => true,
  canVerifyByPhone: () => true,
}));

// The mailer is replaced rather than spied on: `utils/email` destructures `send`
// at module load, so a spy attached afterwards would never be what it calls.
jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

const mailer = require('../src/services/mailer');

const sentTo = (address) =>
  mailer.send.mock.calls.map(([msg]) => msg).filter((msg) => msg.to === address);

/**
 * The sign-in notice is deliberately not awaited by the controller — it reaches
 * an SMTP relay, and nobody signing in should wait on that. So the response
 * arrives before the mail call happens, and asserting straight after the request
 * races it.
 *
 * This awaits the actual work rather than guessing how long it takes. An earlier
 * version span the event loop a fixed number of turns, which looked deterministic
 * and was not: `notifyNewSignIn` waits on real database I/O, so the loop drains
 * while the query is still outstanding. It passed on an empty table and failed
 * once the file had put enough rows in front of it — reporting a *missing*
 * notification for one that was merely late.
 */
const { flushBackground } = require('../src/utils/background');

const drainPendingSends = () => flushBackground();

beforeEach(() => {
  mailer.send.mockClear();
  mailer.send.mockResolvedValue(true);
  mailer.isEnabled.mockReturnValue(true);
});

describe('a deactivated account cannot sign in through any door', () => {
  /*
   * `login` refuses a blocked account before it reaches a session, and says why
   * it has to: `authenticate` would reject the token on the very next request,
   * so issuing one hands out a credential that cannot work and lands a row in
   * the admin's active-sessions view. Both code paths ended in exactly the same
   * `createSession` call and neither carried the check — an administrator could
   * block a parent and the parent would walk straight back in with the code in
   * their inbox, or the SMS on their phone.
   */

  it('refuses the emailed verification code', async () => {
    const email = uniqueEmail('blocked-email');
    const user = await createUser({ email, emailVerified: false, isActive: false });
    await user.update({
      emailVerificationCode: '654321',
      emailVerificationExpires: new Date(Date.now() + 60_000),
    });

    const res = await request(app).post('/api/auth/verify-email').send({ email, code: '654321' });

    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
    expect(res.body.error).toMatch(/deactivated/i);
    expect(await Session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('still records that the address was proved', async () => {
    // The refusal is about the session, not about the fact — the code really
    // was correct, so re-activating the account must not demand it again.
    const email = uniqueEmail('blocked-email-fact');
    const user = await createUser({ email, emailVerified: false, isActive: false });
    await user.update({
      emailVerificationCode: '111222',
      emailVerificationExpires: new Date(Date.now() + 60_000),
    });

    await request(app).post('/api/auth/verify-email').send({ email, code: '111222' }).expect(403);

    await user.reload();
    expect(user.emailVerified).toBe(true);
  });

  it('refuses the SMS code', async () => {
    const phone = '+15551239001';
    const user = await createUser({
      email: uniqueEmail('blocked-phone'),
      phone,
      phoneVerified: true,
      isActive: false,
    });
    await user.update({
      phoneVerificationCode: '123456',
      phoneVerificationExpires: new Date(Date.now() + 60_000),
    });

    const res = await request(app).post('/api/auth/phone/verify').send({ phone, code: '123456' });

    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
    expect(await Session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('does not leak the whole number back in the refusal', async () => {
    const phone = '+15551239002';
    const user = await createUser({
      email: uniqueEmail('blocked-phone-mask'),
      phone,
      phoneVerified: true,
      isActive: false,
    });
    await user.update({
      phoneVerificationCode: '123456',
      phoneVerificationExpires: new Date(Date.now() + 60_000),
    });

    const res = await request(app).post('/api/auth/phone/verify').send({ phone, code: '123456' });

    expect(JSON.stringify(res.body)).not.toContain(phone);
  });
});

describe('the second factor has a ceiling, like every other guessable secret', () => {
  /*
   * `mfa/validate` counted nothing. A wrong code was audit-logged and discarded,
   * so the account-wide lockout that guards the password, the emailed code and
   * the texted code did not exist on the step that is meant to be the strong
   * one — and the route had no limiter of its own either, leaving only the
   * global 300/min backstop between a six-digit number and a guesser.
   */
  const { verify } = require('otplib');

  let user;
  let preAuthToken;

  beforeEach(async () => {
    verify.mockResolvedValue({ valid: false });
    const email = uniqueEmail('mfa-lockout');
    user = await createUser({ email, mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
    const login = await request(app).post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD });
    preAuthToken = login.body.preAuthToken;
  });

  afterEach(() => {
    verify.mockResolvedValue({ valid: true });
  });

  const guess = () =>
    request(app).post('/api/auth/mfa/validate').send({ preAuthToken, code: '000000' });

  it('counts a wrong code against the account', async () => {
    await guess().expect(401);

    await user.reload();
    expect(user.failedLoginAttempts).toBe(1);
  });

  it('locks the account on the fifth wrong code', async () => {
    for (let i = 0; i < 4; i++) await guess().expect(401);

    const fifth = await guess();

    expect(fifth.status).toBe(423);
    await user.reload();
    expect(user.lockedUntil).toBeTruthy();
  });

  it('keeps refusing while the lock holds, even with the right code', async () => {
    for (let i = 0; i < 5; i++) await guess();

    verify.mockResolvedValue({ valid: true });
    const res = await request(app).post('/api/auth/mfa/validate').send({ preAuthToken, code: '123456' });

    expect(res.status).toBe(423);
    expect(res.body.token).toBeUndefined();
  });

  it('clears the counter once the right code arrives', async () => {
    await guess().expect(401);
    await guess().expect(401);

    verify.mockResolvedValue({ valid: true });
    await request(app).post('/api/auth/mfa/validate').send({ preAuthToken, code: '123456' }).expect(200);

    await user.reload();
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });
});

describe('the account holder is told when someone signs in from somewhere new', () => {
  /*
   * Nothing on the platform told a parent that their own account had been
   * opened. Every notification was about the child, so a stolen password was
   * completely silent — the only record was an audit row visible to staff.
   */
  const signIn = (email, agent) =>
    request(app)
      .post('/api/auth/login')
      .set('User-Agent', agent)
      .send({ email, password: DEFAULT_PASSWORD });

  it('says nothing on the first ever sign-in', async () => {
    // That is the person who just registered. Telling them their brand-new
    // account was reached from an unrecognised device is alarming and useless.
    const email = uniqueEmail('signin-first');
    await createUser({ email });

    await signIn(email, 'Chrome/Known').expect(200);
    await drainPendingSends();

    expect(sentTo(email).filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(0);
  });

  it('says nothing when the same device comes back', async () => {
    const email = uniqueEmail('signin-same');
    await createUser({ email });

    await signIn(email, 'Chrome/Known').expect(200);
    mailer.send.mockClear();
    await signIn(email, 'Chrome/Known').expect(200);
    await drainPendingSends();

    expect(sentTo(email).filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(0);
  });

  it('emails the owner when an unrecognised device signs in', async () => {
    const email = uniqueEmail('signin-new');
    await createUser({ email });

    await signIn(email, 'Chrome/Known').expect(200);
    await drainPendingSends();
    mailer.send.mockClear();
    await signIn(email, 'Firefox/Stranger').expect(200);
    await drainPendingSends();

    const notices = sentTo(email).filter((m) => /new sign-in/i.test(m.subject));
    expect(notices).toHaveLength(1);
    // The message has to carry enough for the reader to judge it.
    expect(notices[0].html).toMatch(/Firefox\/Stranger/);
    expect(notices[0].html).toMatch(/change your password/i);
  });

  it('covers the session that email re-verification issues', async () => {
    /*
     * `verify-email` also ends in `createSession`, and it is reached a second
     * time whenever the address is changed — at which point the account does
     * have a history to compare against. Without this it was the one
     * session-issuing path of five that told nobody.
     */
    const email = uniqueEmail('signin-verify');
    const user = await createUser({ email });
    await signIn(email, 'Chrome/Known').expect(200);
    await drainPendingSends();

    // What `updateProfile` leaves behind after an address change.
    await user.update({
      emailVerified: false,
      emailVerificationCode: '424242',
      emailVerificationExpires: new Date(Date.now() + 60_000),
    });
    mailer.send.mockClear();

    await request(app)
      .post('/api/auth/verify-email')
      .set('User-Agent', 'Firefox/Stranger')
      .send({ email, code: '424242' })
      .expect(200);
    await drainPendingSends();

    expect(sentTo(email).filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(1);
  });

  it('does not fail the sign-in when the notice cannot be delivered', async () => {
    const email = uniqueEmail('signin-mailfail');
    await createUser({ email });
    await signIn(email, 'Chrome/Known').expect(200);
    await drainPendingSends();

    mailer.send.mockResolvedValue(false);
    const res = await signIn(email, 'Firefox/Stranger');

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });
});

describe('a password that changes is confirmed to its owner', () => {
  it('emails the holder when they change it themselves', async () => {
    const email = uniqueEmail('pw-changed');
    const user = await createUser({ email });
    const login = await request(app).post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD });

    await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'brand-new-pw9' })
      .expect(200);
    await drainPendingSends();

    const notices = sentTo(email).filter((m) => /password was changed/i.test(m.subject));
    expect(notices).toHaveLength(1);
    expect(user.id).toBeTruthy();
  });

  it('emails the holder when it is reset through the link', async () => {
    const email = uniqueEmail('pw-reset');
    const user = await createUser({ email });
    await user.update({
      passwordResetToken: 'reset-token-abc',
      passwordResetExpires: new Date(Date.now() + 60_000),
    });
    mailer.send.mockClear();

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'reset-token-abc', newPassword: 'brand-new-pw9' })
      .expect(200);
    await drainPendingSends();

    const notices = sentTo(email).filter((m) => /password was changed/i.test(m.subject));
    expect(notices).toHaveLength(1);
    expect(notices[0].html).toMatch(/reset/i);
  });
});

describe('the mailer does not report success for mail it never sent', () => {
  /*
   * The no-provider transport resolved without a value, and `send` read any
   * resolved call as delivered — so with no relay configured every caller that
   * trusts the boolean was told its message had gone out. This is the same
   * "failed request rendered as good news" shape the codebase has hit before.
   */
  it('reports false when no provider is configured', async () => {
    jest.resetModules();
    jest.unmock('../src/services/mailer');
    jest.doMock('../src/config/env', () => ({
      env: { email: { provider: 'none', smtp: {}, from: 'x@y.z' } },
      assertProductionConfig: () => {},
    }));

    const freshMailer = require('../src/services/mailer');
    await expect(freshMailer.send({ to: 'a@b.c', subject: 'x', html: 'y' })).resolves.toBe(false);

    jest.dontMock('../src/config/env');
    jest.resetModules();
  });
});

describe('production refuses to boot without a way to send mail', () => {
  /*
   * Signup does not complete without email: the account cannot log in until the
   * emailed code is entered, and the code exists only in that email. A
   * production boot with no relay therefore accepted registrations all day and
   * stranded every one of them while /api/health reported a healthy service.
   */
  const loadEnv = (overrides) => {
    jest.resetModules();
    const previous = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(40),
      FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
      DATABASE_URL: 'postgres://user:pw@host:5432/db',
      CLIENT_URL: 'https://parentix.ca',
      SMTP_HOST: 'smtp.example.com',
      ...overrides,
    });
    try {
      return require('../src/config/env');
    } finally {
      process.env = previous;
    }
  };

  afterAll(() => jest.resetModules());

  it('refuses when SMTP_HOST is missing', () => {
    const { assertProductionConfig } = loadEnv({ SMTP_HOST: '' });
    expect(() => assertProductionConfig()).toThrow(/SMTP_HOST/);
  });

  it('refuses when SMTP_HOST is the Secret Manager placeholder space', () => {
    // Terraform seeds every externally-supplied secret with a single space, and
    // that space is truthy. It is exactly how all email on the platform stopped
    // once before, with nothing to say so.
    const { assertProductionConfig } = loadEnv({ SMTP_HOST: ' ' });
    expect(() => assertProductionConfig()).toThrow(/SMTP_HOST/);
  });

  it('boots when a relay is configured', () => {
    const { assertProductionConfig } = loadEnv({});
    expect(() => assertProductionConfig()).not.toThrow();
  });
});
