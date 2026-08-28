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
const { createUser, uniqueEmail, signIn: fullSignIn, DEFAULT_PASSWORD } = require('./helpers');
const { hashTicket } = require('../src/utils/otp');

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
  /*
   * A whole sign-in, both requests, with the agent set on each.
   *
   * The notice is raised by whatever creates the session, and since every
   * password sign-in is finished with an emailed code that is now
   * `POST /auth/login/verify` rather than `POST /auth/login`. A helper that
   * stopped at the password would create no session at all — and every
   * assertion here would then pass by finding no notice for a sign-in that
   * never happened.
   */
  const signIn = (email, agent) => fullSignIn(email, DEFAULT_PASSWORD, { userAgent: agent });

  it('says nothing on the first ever sign-in', async () => {
    // That is the person who just registered. Telling them their brand-new
    // account was reached from an unrecognised device is alarming and useless.
    const email = uniqueEmail('signin-first');
    await createUser({ email });

    expect((await signIn(email, 'Chrome/Known')).status).toBe(200);
    await drainPendingSends();

    expect(sentTo(email).filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(0);
  });

  it('says nothing when the same device comes back', async () => {
    const email = uniqueEmail('signin-same');
    await createUser({ email });

    expect((await signIn(email, 'Chrome/Known')).status).toBe(200);
    mailer.send.mockClear();
    expect((await signIn(email, 'Chrome/Known')).status).toBe(200);
    await drainPendingSends();

    expect(sentTo(email).filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(0);
  });

  it('emails the owner when an unrecognised device signs in', async () => {
    const email = uniqueEmail('signin-new');
    await createUser({ email });

    expect((await signIn(email, 'Chrome/Known')).status).toBe(200);
    await drainPendingSends();
    mailer.send.mockClear();
    expect((await signIn(email, 'Firefox/Stranger')).status).toBe(200);
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
    expect((await signIn(email, 'Chrome/Known')).status).toBe(200);
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
    expect((await signIn(email, 'Chrome/Known')).status).toBe(200);
    await drainPendingSends();

    /*
     * Only the notice fails, not every message.
     *
     * A blanket `mockResolvedValue(false)` also breaks the emailed sign-in
     * code, and *that* failure is supposed to refuse the session — a second
     * factor that stops applying when the mail relay is sick is no factor at
     * all. Failing the one subject under test keeps this about what it says it
     * is about: a notice nobody is waiting on must not take the sign-in with it.
     */
    mailer.send.mockImplementation(async (msg) => !/new sign-in/i.test(msg?.subject || ''));
    const res = await signIn(email, 'Firefox/Stranger');

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });
});

describe('a password that changes is confirmed to its owner', () => {
  it('emails the holder when they change it themselves', async () => {
    const email = uniqueEmail('pw-changed');
    const user = await createUser({ email });
    const login = await fullSignIn(email);

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
    // The column holds a keyed digest, never the ticket — so a fixture that
    // plants one has to plant it in the stored form. See `otp.hashTicket`.
    await user.update({
      passwordResetToken: hashTicket('reset-token-abc'),
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

/**
 * Sign-in answers "no such address" and "wrong password" with the same 401, and
 * the clock used to give the difference away anyway.
 *
 * `!user || !(await user.comparePassword(...))` short-circuits, so an unknown
 * address never reached bcrypt: it answered in about a millisecond while a real
 * account spent the ~200ms of a cost-12 comparison. That is measurable across
 * the internet, and it enumerates the customer base as reliably as a "no such
 * user" message would — the very disclosure `forgot-password` two screens away
 * goes to some length to avoid.
 *
 * Asserted as a floor rather than as a ratio. A ratio is a flaky test on shared
 * CI; "the unknown-address path did real work" is the property, and a refactor
 * that drops the comparison fails this immediately because it returns in single
 * -digit milliseconds.
 */
describe('an unknown address costs what a wrong password costs', () => {
  const timeLogin = async (email, password) => {
    const started = process.hrtime.bigint();
    await request(app).post('/api/auth/login').send({ email, password }).expect(401);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  it('runs a password comparison even when there is no account', async () => {
    const known = uniqueEmail('timing');
    await createUser({ email: known });

    const wrongPassword = await timeLogin(known, 'definitely-not-it-9');
    const noSuchAccount = await timeLogin(uniqueEmail('timing-absent'), 'definitely-not-it-9');

    // bcrypt at cost 12 is ~100–300ms on any machine this runs on; the
    // short-circuited path was ~1ms. 40ms separates the two with room to spare.
    expect(wrongPassword).toBeGreaterThan(40);
    expect(noSuchAccount).toBeGreaterThan(40);
  });

  it('does the same for an account that has no password at all', async () => {
    // Google and phone signups store no hash, so `comparePassword` returned
    // false without hashing — the same tell, for the accounts least likely to
    // be signing in with a password.
    const email = uniqueEmail('timing-google');
    await createUser({ email, passwordHash: null, googleId: `g-${email}` });

    expect(await timeLogin(email, 'definitely-not-it-9')).toBeGreaterThan(40);
  });

  it('reports the same refusal either way', async () => {
    const known = uniqueEmail('timing-body');
    await createUser({ email: known });

    const a = await request(app).post('/api/auth/login')
      .send({ email: known, password: 'definitely-not-it-9' }).expect(401);
    const b = await request(app).post('/api/auth/login')
      .send({ email: uniqueEmail('timing-body-absent'), password: 'definitely-not-it-9' }).expect(401);

    expect(a.body).toEqual(b.body);
  });
});

describe('production refuses to boot without a way to send mail', () => {
  /*
   * Signup does not complete without email: the account cannot log in until the
   * emailed code is entered, and the code exists only in that email. A
   * production boot with no relay therefore accepted registrations all day and
   * stranded every one of them while /api/health reported a healthy service.
   */
  /**
   * Note the NODE_ENV it sets. `config/env.js` skips dotenv under `test` and
   * this block deliberately reloads it as `production`, so the developer's
   * `services/api/.env` *is* read here — which means every variable
   * `assertProductionConfig` looks at has to be stated, or the assertion below
   * is really about whoever's laptop is running it. Both SMTP credentials are
   * named for exactly that reason.
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
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'apikey',
      SMTP_PASS: 'relay-password',
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
