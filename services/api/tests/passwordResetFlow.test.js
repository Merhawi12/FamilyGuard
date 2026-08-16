/**
 * The self-service password reset, through the API — three steps and a code.
 *
 * `forgot-password` mails six digits, `verify-reset-code` exchanges them for a
 * single-use ticket, and `reset-password` spends it. The code is read out of the
 * mocked mailer rather than off the user row, and that is the point rather than
 * a convenience: the row holds a keyed hash, so a suite that could read a code
 * from it would be a suite proving the codes are still in plain text.
 * `tests/mailDelivery.smtp.test.js` is what proves the same digits reach a real
 * relay in a real message.
 *
 * What each step must never do is as load-bearing as what it does:
 *   - `forgot-password` must answer identically for an address with an account
 *     and one without — including when it refuses to send.
 *   - `verify-reset-code` must give one sentence for every kind of refusal.
 *   - a wrong reset code must not lock the account, because this is the flow
 *     somebody walks when they are already locked out of everything else.
 */
jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { User, Session } = require('../src/models');
const mailer = require('../src/services/mailer');
const { createUser, DEFAULT_PASSWORD, rewindOtpCooldown } = require('./helpers');
const { MAX_ATTEMPTS, MAX_SENDS_PER_WINDOW } = require('../src/utils/otp');

const forgot = (email) => request(app).post('/api/auth/forgot-password').send({ email });
const verifyCode = (email, code) => request(app).post('/api/auth/verify-reset-code').send({ email, code });
const reset = (token, newPassword) => request(app).post('/api/auth/reset-password').send({ token, newPassword });
const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

/** The digits as the emailed message carries them. */
const lastCode = () => mailer.send.mock.calls.at(-1)[0].html.match(/>(\d{6})</)[1];

/** Request a code and read it back out of the message. */
const codeFor = async (user) => {
  await forgot(user.email);
  return lastCode();
};

/** Walk the whole flow to the ticket the last step spends. */
const ticketFor = async (user) => {
  const res = await verifyCode(user.email, await codeFor(user));
  return res.body.resetToken;
};

beforeEach(() => {
  mailer.send.mockClear();
  mailer.send.mockResolvedValue(true);
  mailer.isEnabled.mockReturnValue(true);
});

// ── Test A — a registered account ────────────────────────────────────────────
describe('Test A — a registered account', () => {
  it('mails a six-digit code and stores it hashed, never as digits', async () => {
    const user = await createUser();

    expect((await forgot(user.email)).status).toBe(200);

    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);

    const stored = await User.findByPk(user.id);
    // The whole reason a database dump is not a pile of live credentials.
    expect(stored.passwordResetCode).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.passwordResetCode).not.toContain(code);
    expect(new Date(stored.passwordResetCodeExpires).getTime()).toBeGreaterThan(Date.now());

    // And no ticket exists until the code comes back.
    expect(stored.passwordResetToken).toBeNull();
  });

  it('exchanges the code for a ticket, and the ticket for a new password', async () => {
    const user = await createUser();

    const verified = await verifyCode(user.email, await codeFor(user));
    expect(verified.status).toBe(200);
    expect(verified.body.resetToken).toMatch(/^[a-f0-9]{64}$/);

    expect((await reset(verified.body.resetToken, 'brand-new-pass-9')).status).toBe(200);

    expect((await login(user.email, 'brand-new-pass-9')).status).toBe(200);
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(401);
  });

  it('consumes the code, so the same six digits cannot be presented twice', async () => {
    const user = await createUser();
    const code = await codeFor(user);

    expect((await verifyCode(user.email, code)).status).toBe(200);

    const replay = await verifyCode(user.email, code);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/invalid or expired/i);
  });

  it('consumes the ticket on use, so the same one cannot be replayed', async () => {
    const user = await createUser();
    const token = await ticketFor(user);

    expect((await reset(token, 'first-password-1')).status).toBe(200);
    expect((await reset(token, 'second-password-2')).status).toBe(400);

    // The first reset stands.
    expect((await login(user.email, 'first-password-1')).status).toBe(200);
  });

  it('signs every other device out, because a reset is compromise recovery', async () => {
    const user = await createUser();
    await Session.create({ userId: user.id });
    await Session.create({ userId: user.id });

    await reset(await ticketFor(user), 'rotate-me-now-3');

    expect(await Session.count({ where: { userId: user.id, revoked: false } })).toBe(0);
  });

  it('clears a lockout, so a locked-out parent can recover by resetting', async () => {
    const user = await createUser({
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    await reset(await ticketFor(user), 'unlock-me-please-4');

    const reloaded = await User.findByPk(user.id);
    expect(reloaded.lockedUntil).toBeNull();
    expect(reloaded.failedLoginAttempts).toBe(0);
    expect((await login(user.email, 'unlock-me-please-4')).status).toBe(200);
  });

  it('holds the new password to the same policy as registration', async () => {
    const user = await createUser();
    const token = await ticketFor(user);

    expect((await reset(token, 'short1')).status).toBe(400);
    expect((await reset(token, 'nodigitsanywhere')).status).toBe(400);

    // A rejected attempt must not burn the ticket — otherwise a typo costs the
    // parent the whole flow and they start again from the email.
    expect((await reset(token, 'acceptable-pass-5')).status).toBe(200);
  });

  it('issues the code to the right account and nobody else', async () => {
    const target = await createUser();
    const bystander = await createUser();

    await forgot(target.email);

    expect((await User.findByPk(target.id)).passwordResetCode).toMatch(/^[a-f0-9]{64}$/);
    expect((await User.findByPk(bystander.id)).passwordResetCode).toBeNull();
  });

  it('mints a different code every time', async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const user = await createUser();
      seen.add(await codeFor(user));
    }
    // Six digits collide once in a million; five draws colliding is a broken
    // generator, not luck.
    expect(seen.size).toBe(5);
  });

  it('clears the code once the password has actually changed', async () => {
    const user = await createUser();
    await reset(await ticketFor(user), 'all-cleaned-up-6');

    const after = await User.findByPk(user.id);
    expect(after.passwordResetCode).toBeNull();
    expect(after.passwordResetCodeExpires).toBeNull();
    expect(after.passwordResetToken).toBeNull();
  });
});

// ── Test B — an address nobody registered ────────────────────────────────────
describe('Test B — an unregistered address', () => {
  it('answers identically to a real account, so the endpoint cannot enumerate', async () => {
    const real = await createUser();

    const known = await forgot(real.email);
    const unknown = await forgot('definitely-not-registered@example.com');

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.body.message).toMatch(/if an account exists/i);
  });

  it('sends nothing at all for an address with no account', async () => {
    await forgot('nobody-here@example.com');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('never returns the code in the response body', async () => {
    const user = await createUser();

    const res = await forgot(user.email);

    expect(JSON.stringify(res.body)).not.toContain(lastCode());
    expect(res.body.code).toBeUndefined();
    expect(res.body.resetToken).toBeUndefined();
  });

  it('gives an unknown address the same refusal as a wrong code', async () => {
    const user = await createUser();
    await forgot(user.email);

    const wrongCode = await verifyCode(user.email, '000000');
    const noAccount = await verifyCode('stranger@example.com', '000000');

    expect(noAccount.status).toBe(wrongCode.status);
    expect(noAccount.body).toEqual(wrongCode.body);
  });

  it('rejects a request with no address at all', async () => {
    expect((await request(app).post('/api/auth/forgot-password').send({})).status).toBe(400);
  });
});

// ── Test C — an expired code ─────────────────────────────────────────────────
describe('Test C — an expired code', () => {
  it('is refused, and the old password still works', async () => {
    const user = await createUser();
    const code = await codeFor(user);

    await user.update({ passwordResetCodeExpires: new Date(Date.now() - 1000) });

    const res = await verifyCode(user.email, code);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);

    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('is refused when the expiry is missing entirely', async () => {
    const user = await createUser();
    const code = await codeFor(user);

    /**
     * Cleared with a static update, not `user.update(...)`, and the difference
     * is the whole test — see the same note in the suite this replaced. What
     * Sequelize does with `null` on an attribute an instance has never loaded
     * depends on the driver, so on Postgres no UPDATE was issued at all and the
     * row kept a perfectly valid expiry. `Model.update` is a query rather than a
     * diff of an instance, so the state under test exists on both engines.
     */
    await User.update({ passwordResetCodeExpires: null }, { where: { id: user.id } });
    expect((await User.findByPk(user.id)).passwordResetCodeExpires).toBeNull();

    expect((await verifyCode(user.email, code)).status).toBe(400);
  });

  it('refuses a ticket whose fifteen minutes have run out', async () => {
    const user = await createUser();
    const token = await ticketFor(user);

    await User.update({ passwordResetExpires: new Date(Date.now() - 1000) }, { where: { id: user.id } });

    expect((await reset(token, 'too-late-friend-7')).status).toBe(400);
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });
});

// ── Test D — a wrong code ────────────────────────────────────────────────────
describe('Test D — an incorrect code', () => {
  it('is refused without changing the password', async () => {
    const user = await createUser();
    await forgot(user.email);

    const res = await verifyCode(user.email, '000000');

    expect(res.status).toBe(400);
    expect(res.body.resetToken).toBeUndefined();
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('burns the code after five wrong guesses, so a guesser cannot grind it', async () => {
    const user = await createUser();
    const code = await codeFor(user);

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      // Spread across addresses, so the per-IP limiter is not what stops this.
      await request(app).post('/api/auth/verify-reset-code')
        .set('X-Forwarded-For', `10.0.1.${i}`)
        .send({ email: user.email, code: String(100000 + i) });
    }

    // Even the right code is dead now.
    expect((await verifyCode(user.email, code)).status).toBe(400);
    expect((await User.findByPk(user.id)).passwordResetCode).toBeNull();
  });

  it('does not lock the account, because this is the recovery path', async () => {
    /*
     * Every other code on this service counts a wrong guess towards the account
     * lockout. Here that would hand anyone who knows an address a way to lock
     * its owner out of the one flow that exists to get them back in — so the
     * code dies and the account does not.
     */
    const user = await createUser();
    await forgot(user.email);

    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      await request(app).post('/api/auth/verify-reset-code')
        .set('X-Forwarded-For', `10.0.2.${i}`)
        .send({ email: user.email, code: '000000' });
    }

    const after = await User.findByPk(user.id);
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginAttempts).toBe(0);
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('lets the parent recover by asking for a fresh code', async () => {
    const user = await createUser();
    await codeFor(user);

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await request(app).post('/api/auth/verify-reset-code')
        .set('X-Forwarded-For', `10.0.3.${i}`)
        .send({ email: user.email, code: '000000' });
    }

    await rewindOtpCooldown(user, 'reset');
    const fresh = await codeFor(user);

    // A new code arrives with its own attempt budget — the spent one must not
    // poison it.
    expect((await verifyCode(user.email, fresh)).status).toBe(200);
  });

  it('refuses a missing code or a missing address outright', async () => {
    const user = await createUser();
    expect((await verifyCode(user.email, '')).status).toBe(400);
    expect((await verifyCode('', '123456')).status).toBe(400);
  });

  it('refuses a missing or empty ticket outright', async () => {
    expect((await request(app).post('/api/auth/reset-password')
      .send({ newPassword: 'no-token-at-all-1' })).status).toBe(400);
    expect((await reset('', 'no-token-at-all-1')).status).toBe(400);
  });
});

// ── Test E — asking for another code ─────────────────────────────────────────
describe('Test E — resend', () => {
  it('issues a fresh code and kills the previous one', async () => {
    const user = await createUser();

    const first = await codeFor(user);
    await rewindOtpCooldown(user, 'reset');
    const second = await codeFor(user);

    expect(second).not.toBe(first);

    // The superseded code must be dead. Otherwise every request ever made
    // leaves a live key to the account sitting in an inbox.
    expect((await verifyCode(user.email, first)).status).toBe(400);
    expect((await verifyCode(user.email, second)).status).toBe(200);
  });

  it('kills a ticket that was already outstanding', async () => {
    /*
     * Asking for a new code is what somebody does when the last attempt went
     * astray. A half-finished reset that stays live is a key to the account
     * sitting in whatever went wrong the first time.
     */
    const user = await createUser();
    const token = await ticketFor(user);

    await rewindOtpCooldown(user, 'reset');
    await forgot(user.email);

    expect((await reset(token, 'stale-ticket-pass-8')).status).toBe(400);
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('refuses a second code inside the cooldown — silently, and without sending', async () => {
    const user = await createUser();
    await forgot(user.email);
    mailer.send.mockClear();

    const res = await forgot(user.email);

    // The answer is unchanged, because saying "wait 60 seconds" would confirm
    // the address has an account. The mailer is where the refusal is visible.
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(mailer.send).not.toHaveBeenCalled();

    // And the code already in the parent's inbox is untouched by the refusal.
    expect((await User.findByPk(user.id)).passwordResetCode).toMatch(/^[a-f0-9]{64}$/);
  });

  it('stops sending after five in an hour, however patient the caller is', async () => {
    const user = await createUser();

    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
      await forgot(user.email);
      await rewindOtpCooldown(user, 'reset');
    }
    expect(mailer.send).toHaveBeenCalledTimes(MAX_SENDS_PER_WINDOW);

    mailer.send.mockClear();
    const res = await forgot(user.email);

    expect(res.status).toBe(200);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('extends the expiry with each code that is actually sent', async () => {
    const user = await createUser();

    await forgot(user.email);
    const first = new Date((await User.findByPk(user.id)).passwordResetCodeExpires).getTime();

    await rewindOtpCooldown(user, 'reset');
    await new Promise((r) => setTimeout(r, 1100));
    await forgot(user.email);
    const second = new Date((await User.findByPk(user.id)).passwordResetCodeExpires).getTime();

    expect(second).toBeGreaterThan(first);
  });

  // Per-IP rate limiting lives in authRateLimit.test.js: this suite runs against
  // the pass-through mock in __mocks__/express-rate-limit.js, which is what lets
  // it make several requests in a row at all. The limits asserted here are the
  // per-account ones, which is the half no IP ceiling can cover.
});
