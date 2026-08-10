/**
 * The self-service password reset, through the API.
 *
 * The link in the email carries the token this suite reads back off the user
 * row — `tests/mailDelivery.smtp.test.js` is what proves that same token reaches
 * a relay inside a working URL. Between them the chain is covered end to end:
 * the controller mints and stores a token, the mailer puts that token in a link,
 * and the endpoints here accept it exactly once.
 *
 * Reading it from the database rather than from the response is deliberate — the
 * token must never appear in a response body, and one of these asserts that.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { User, Session } = require('../src/models');
const { createUser, DEFAULT_PASSWORD } = require('./helpers');

const forgot = (email) => request(app).post('/api/auth/forgot-password').send({ email });
const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });
const reset = (token, newPassword) => request(app).post('/api/auth/reset-password').send({ token, newPassword });

/** The token as the emailed link would carry it. */
const issuedTokenFor = async (user) => {
  await forgot(user.email);
  const reloaded = await User.findByPk(user.id);
  return reloaded.passwordResetToken;
};

// ── Test A — a registered account ────────────────────────────────────────────
describe('Test A — a registered account', () => {
  it('issues a single-use token and lets the parent sign in with the new password', async () => {
    const user = await createUser();

    expect((await forgot(user.email)).status).toBe(200);

    const stored = await User.findByPk(user.id);
    expect(stored.passwordResetToken).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(stored.passwordResetExpires).getTime()).toBeGreaterThan(Date.now());

    expect((await reset(stored.passwordResetToken, 'brand-new-pass-9')).status).toBe(200);

    expect((await login(user.email, 'brand-new-pass-9')).status).toBe(200);
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(401);
  });

  it('clears the token on use, so the same link cannot be replayed', async () => {
    const user = await createUser();
    const token = await issuedTokenFor(user);

    expect((await reset(token, 'first-password-1')).status).toBe(200);

    const replay = await reset(token, 'second-password-2');
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/invalid or expired/i);

    // The first reset stands.
    expect((await login(user.email, 'first-password-1')).status).toBe(200);
  });

  it('signs every other device out, because a reset is compromise recovery', async () => {
    const user = await createUser();
    await Session.create({ userId: user.id });
    await Session.create({ userId: user.id });

    await reset(await issuedTokenFor(user), 'rotate-me-now-3');

    expect(await Session.count({ where: { userId: user.id, revoked: false } })).toBe(0);
  });

  it('clears a lockout, so a locked-out parent can recover by resetting', async () => {
    const user = await createUser({
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });

    await reset(await issuedTokenFor(user), 'unlock-me-please-4');

    const reloaded = await User.findByPk(user.id);
    expect(reloaded.lockedUntil).toBeNull();
    expect(reloaded.failedLoginAttempts).toBe(0);
    expect((await login(user.email, 'unlock-me-please-4')).status).toBe(200);
  });

  it('holds the new password to the same policy as registration', async () => {
    const user = await createUser();
    const token = await issuedTokenFor(user);

    expect((await reset(token, 'short1')).status).toBe(400);
    expect((await reset(token, 'nodigitsanywhere')).status).toBe(400);

    // A rejected attempt must not burn the token — otherwise a typo costs the
    // parent the link and they have to start again.
    expect((await reset(token, 'acceptable-pass-5')).status).toBe(200);
  });

  it('stores the token against the right account and nobody else', async () => {
    const target = await createUser();
    const bystander = await createUser();

    await forgot(target.email);

    expect((await User.findByPk(target.id)).passwordResetToken).toMatch(/^[a-f0-9]{64}$/);
    expect((await User.findByPk(bystander.id)).passwordResetToken).toBeNull();
  });

  it('mints a different token every time', async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const user = await createUser();
      seen.add(await issuedTokenFor(user));
    }
    expect(seen.size).toBe(5);
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

  it('never returns the token in the response body', async () => {
    const user = await createUser();

    const res = await forgot(user.email);
    const stored = await User.findByPk(user.id);

    expect(JSON.stringify(res.body)).not.toContain(stored.passwordResetToken);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects a request with no address at all', async () => {
    expect((await request(app).post('/api/auth/forgot-password').send({})).status).toBe(400);
  });
});

// ── Test C — an expired link ─────────────────────────────────────────────────
describe('Test C — an expired link', () => {
  it('is refused, and the old password still works', async () => {
    const user = await createUser();
    const token = await issuedTokenFor(user);

    await user.update({ passwordResetExpires: new Date(Date.now() - 1000) });

    const res = await reset(token, 'too-late-friend-6');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);

    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('is refused when the expiry is missing entirely', async () => {
    const user = await createUser();
    const token = await issuedTokenFor(user);

    /**
     * Cleared with a static update, not `user.update(...)`, and the difference
     * is the whole test.
     *
     * `user` is a handle taken before `forgot-password` ran, so it has never
     * loaded `passwordResetExpires`. What Sequelize does with `null` on that
     * handle depends on the driver: after an INSERT ... RETURNING (Postgres) the
     * attribute is already `null`, so assigning `null` is not a change, no
     * UPDATE is issued at all, and the row keeps its perfectly valid expiry —
     * the test then drove the happy path and called the resulting 200 a
     * regression. On SQLite the attribute is `undefined`, `null` counts as a
     * change, the write happens, and the same test passed for the right reason.
     *
     * `Model.update` is a query rather than a diff of an instance, so the state
     * this test is about actually exists on both engines.
     */
    await User.update({ passwordResetExpires: null }, { where: { id: user.id } });
    expect((await User.findByPk(user.id)).passwordResetExpires).toBeNull();

    expect((await reset(token, 'no-expiry-set-7')).status).toBe(400);
  });
});

// ── Test D — a wrong token ───────────────────────────────────────────────────
describe('Test D — an incorrect token', () => {
  it('is refused without changing the password', async () => {
    const user = await createUser();
    await issuedTokenFor(user);

    const res = await reset('f'.repeat(64), 'not-my-token-8');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
    expect((await login(user.email, DEFAULT_PASSWORD)).status).toBe(200);
  });

  it('gives the same answer for a wrong token and an unknown one', async () => {
    const user = await createUser();
    await issuedTokenFor(user);

    const wrong = await reset('f'.repeat(64), 'valid-password-9');
    const nonsense = await reset('not-even-hex', 'valid-password-9');

    expect(wrong.body.error).toBe(nonsense.body.error);
  });

  it('refuses a missing or empty token outright', async () => {
    expect((await request(app).post('/api/auth/reset-password')
      .send({ newPassword: 'no-token-at-all-1' })).status).toBe(400);
    expect((await reset('', 'no-token-at-all-1')).status).toBe(400);
  });
});

// ── Test E — requesting a second link ────────────────────────────────────────
describe('Test E — resend', () => {
  it('issues a fresh token and invalidates the previous one', async () => {
    const user = await createUser();

    const first = await issuedTokenFor(user);
    const second = await issuedTokenFor(user);

    expect(second).not.toBe(first);

    // The superseded link must be dead. Otherwise every request ever made
    // leaves a live key to the account sitting in an inbox.
    expect((await reset(first, 'stale-link-pass-2')).status).toBe(400);

    expect((await reset(second, 'fresh-link-pass-3')).status).toBe(200);
    expect((await login(user.email, 'fresh-link-pass-3')).status).toBe(200);
  });

  it('extends the expiry with each new request', async () => {
    const user = await createUser();

    await forgot(user.email);
    const firstExpiry = new Date((await User.findByPk(user.id)).passwordResetExpires).getTime();

    await new Promise((r) => setTimeout(r, 1100));
    await forgot(user.email);
    const secondExpiry = new Date((await User.findByPk(user.id)).passwordResetExpires).getTime();

    expect(secondExpiry).toBeGreaterThan(firstExpiry);
  });

  // Rate limiting lives in authRateLimit.test.js: this suite runs against the
  // pass-through mock in __mocks__/express-rate-limit.js, which is what lets it
  // request several links in a row at all.
});
