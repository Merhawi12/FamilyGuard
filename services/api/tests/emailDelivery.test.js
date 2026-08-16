/**
 * Signing up is only half a flow: the account cannot be used until the emailed
 * code is entered, so a verification email that does not go out strands the
 * account permanently.
 *
 * Registration used to fire that email and forget it, then answer "Verification
 * code sent to your email" whatever happened. A rejected SMTP login — an expired
 * Gmail app password, a revoked API key — therefore looked exactly like success
 * from the client, and the only trace was a line in a server log. These pin the
 * delivery result to the response so a broken relay is visible to the person it
 * is blocking.
 *
 * The mailer is replaced rather than spied on: `utils/email` destructures `send`
 * at module load, so a spy attached to the module object afterwards would never
 * be the function it calls.
 */
jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const mailer = require('../src/services/mailer');
const { rewindOtpCooldown } = require('./helpers');

const register = (email) => request(app).post('/api/auth/register')
  .send({ name: 'Delivery Test', email, password: 'password123' });

describe('a verification email that cannot be sent is reported', () => {
  beforeEach(() => {
    mailer.send.mockResolvedValue(true);
    mailer.isEnabled.mockReturnValue(true);
  });

  it('reports delivery when the relay accepts the message', async () => {
    const res = await register('delivered@example.com').expect(201);

    expect(res.body.emailDelivered).toBe(true);
    expect(res.body.message).toMatch(/sent to your email/i);
  });

  it('reports the failure rather than claiming the code was sent', async () => {
    // What a rejected SMTP login looks like from here: `send` swallows the
    // transport error and reports that nothing went out.
    mailer.send.mockResolvedValue(false);

    const res = await register('undelivered@example.com').expect(201);

    expect(res.body.emailDelivered).toBe(false);
    expect(res.body.message).not.toMatch(/sent to your email/i);
    expect(res.body.message).toMatch(/could not deliver/i);
  });

  it('still creates the account, so a resend can finish the job', async () => {
    mailer.send.mockResolvedValue(false);

    await register('stranded@example.com').expect(201);

    const user = await User.findByEmail('stranded@example.com');
    expect(user).not.toBeNull();
    expect(user.emailVerified).toBe(false);
    // Stored as a keyed hash, never as the digits — see utils/otp.js. The code
    // itself exists only in the message, which is what the mock above holds.
    expect(user.emailVerificationCode).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports the same failure on a resend', async () => {
    await register('resend@example.com').expect(201);
    mailer.send.mockResolvedValue(false);
    // A minute has to pass between codes. Simulated rather than waited out —
    // the cooldown itself is asserted in tests/otp.test.js.
    await rewindOtpCooldown(await User.findByEmail('resend@example.com'));

    const res = await request(app).post('/api/auth/resend-code')
      .send({ email: 'resend@example.com' })
      .expect(200);

    expect(res.body.emailDelivered).toBe(false);
    expect(res.body.message).toMatch(/could not deliver/i);
  });

  it('a delivered resend still says so', async () => {
    await register('resend-ok@example.com').expect(201);
    await rewindOtpCooldown(await User.findByEmail('resend-ok@example.com'));

    const res = await request(app).post('/api/auth/resend-code')
      .send({ email: 'resend-ok@example.com' })
      .expect(200);

    expect(res.body.emailDelivered).toBe(true);
  });
});
