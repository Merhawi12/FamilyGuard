/**
 * The credential-guessing endpoints have to be limited by attempt count, not
 * only by the global 300/min backstop.
 *
 * The rest of the suite replaces `express-rate-limit` with a pass-through (see
 * `__mocks__/`) so ordinary tests are not throttled — which also means no other
 * test can notice a limiter going missing. This file opts back into the real
 * implementation and mounts the auth router on its own to check the limits are
 * genuinely wired.
 */
jest.unmock('express-rate-limit');

const express = require('express');
const request = require('supertest');

let app;

beforeAll(() => {
  // Deliberately no `jest.resetModules()`: a fresh registry would build a
  // second Sequelize instance, and its connection pool is not the one
  // `db.setup.js` closes — which left the Postgres run hanging after the tests
  // had all passed. `jest.unmock` above is enough on its own, because this file
  // has its own module registry and has not required the limiter yet.
  app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
});

/** Fires the same request until it is refused, or gives up. */
const hammer = async (path, body, attempts) => {
  for (let i = 0; i < attempts; i += 1) {
    const res = await request(app).post(path).send(typeof body === 'function' ? body(i) : body);
    if (res.status === 429) return i + 1;
  }
  return null;
};

describe('auth endpoints are rate limited', () => {
  it('limits password guessing on login', async () => {
    const at = await hammer('/api/auth/login', { email: 'nobody@example.com', password: 'wrong' }, 40);
    expect(at).not.toBeNull();
  });

  it('limits guessing of the six-digit email verification code', async () => {
    // Without this the code could be brute-forced inside its 15-minute window:
    // the global limiter alone allows thousands of attempts against 900k codes.
    const at = await hammer(
      '/api/auth/verify-email',
      (i) => ({ email: 'victim@example.com', code: String(100000 + i) }),
      40,
    );
    expect(at).not.toBeNull();
  });

  it('limits password-reset token submission', async () => {
    const at = await hammer('/api/auth/reset-password', { token: 'guess', newPassword: 'password123' }, 40);
    expect(at).not.toBeNull();
  });

  it('limits registration', async () => {
    const at = await hammer(
      '/api/auth/register',
      (i) => ({ name: 'Flood', email: `flood${i}@example.com`, password: 'password123' }),
      40,
    );
    expect(at).not.toBeNull();
  });

  it('limits verification-code resends', async () => {
    const at = await hammer('/api/auth/resend-code', { email: 'victim@example.com' }, 40);
    expect(at).not.toBeNull();
  });

  it('limits how often a reset code can be requested for one address', async () => {
    // Unlimited, this is a mail bomb aimed at any address the attacker names,
    // and it reissues the victim's code on every call — so the one they were
    // part-way through typing stops working. The per-account limits in
    // otp.test.js are the other half of this; neither covers the other, because
    // one caps a machine and the other caps a recipient.
    const at = await hammer('/api/auth/forgot-password', { email: 'victim@example.com' }, 40);
    expect(at).not.toBeNull();
  });
});
