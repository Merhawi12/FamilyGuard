/**
 * Phone sign-in — request a code, then present it.
 *
 * The provider is replaced rather than reached: what is worth pinning is not
 * that an HTTP POST to Twilio works, but everything the controller does around
 * it, because most of these are account-takeover routes if they go wrong:
 *
 *   - a number written three ways must resolve to one account, not three
 *   - a wrong code must not sign anyone in, and must count towards the lockout
 *   - an expired code must not be accepted
 *   - a second factor must not be skipped
 *   - a number already verified by someone else must not be re-registered
 *   - a code that could not be sent must be reported as not sent
 */
const mockSendVerificationSms = jest.fn();
jest.mock('../src/services/sms', () => ({
  sendVerificationSms: (...args) => mockSendVerificationSms(...args),
  isEnabled: () => true,
  // Every export the real module has, including this one. A hand-written mock
  // that lists only the functions the suite happens to call is how a controller
  // gets to destructure `undefined` and still see a green run — the same trap
  // that let the MFA endpoint answer 500 in production behind a passing suite.
  canVerifyByPhone: () => true,
  send: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');

const PHONE = '+14155550123';

/** Pulls the code out of the mocked sender rather than reading the column. */
const lastCode = () => mockSendVerificationSms.mock.calls.at(-1)[0].code;

const requestCode = (body) => request(app).post('/api/auth/phone/request').send(body);
const verifyCode = (body) => request(app).post('/api/auth/phone/verify').send(body);

beforeEach(async () => {
  mockSendVerificationSms.mockReset();
  mockSendVerificationSms.mockResolvedValue(true);
  await User.destroy({ where: {}, force: true });
});

describe('requesting a code', () => {
  it('creates an account and sends a code when registering', async () => {
    const res = await requestCode({ mode: 'register', name: 'Sam Rivera', phone: PHONE });

    expect(res.status).toBe(200);
    expect(res.body.smsDelivered).toBe(true);
    expect(mockSendVerificationSms).toHaveBeenCalledTimes(1);

    const user = await User.findByPhone(PHONE);
    expect(user.name).toBe('Sam Rivera');
    expect(user.phoneVerified).toBe(false);
    // No address and no password: the two things migration 0012 had to make
    // nullable for this row to be insertable at all.
    expect(user.email).toBeNull();
    expect(user.passwordHash).toBeNull();
  });

  it('never returns the whole number it was given', async () => {
    const res = await requestCode({ mode: 'register', name: 'Sam', phone: PHONE });
    expect(res.body.phone).not.toContain('4155550');
    expect(res.body.phone).toContain('0123');
  });

  it('reports a code that could not be sent as not sent', async () => {
    mockSendVerificationSms.mockResolvedValue(false);
    const res = await requestCode({ mode: 'register', name: 'Sam', phone: PHONE });

    // The account is still created — what failed is delivery, and saying
    // otherwise strands the person on a screen awaiting a message that is not
    // coming, with nothing to explain why.
    expect(res.status).toBe(200);
    expect(res.body.smsDelivered).toBe(false);
    expect(await User.findByPhone(PHONE)).not.toBeNull();
  });

  it('rejects a number with no country code', async () => {
    const res = await requestCode({ mode: 'register', name: 'Sam', phone: '4155550123' });
    expect(res.status).toBe(400);
    expect(mockSendVerificationSms).not.toHaveBeenCalled();
  });

  it('refuses to re-register a number someone has already verified', async () => {
    await User.create({ name: 'First', phone: PHONE, phoneVerified: true });
    const res = await requestCode({ mode: 'register', name: 'Second', phone: PHONE });
    expect(res.status).toBe(409);
  });

  it('lets an abandoned signup be claimed by the real owner', async () => {
    // Unverified: nobody has proved they hold this number, so refusing it
    // would let anyone permanently deny an account to any number they can type.
    await User.create({ name: 'Abandoned', phone: PHONE, phoneVerified: false });
    const res = await requestCode({ mode: 'register', name: 'Real Owner', phone: PHONE });

    expect(res.status).toBe(200);
    expect((await User.findByPhone(PHONE)).name).toBe('Real Owner');
    expect(await User.count({ where: { phone: PHONE } })).toBe(1);
  });

  it('will not send a login code to a number with no account', async () => {
    const res = await requestCode({ mode: 'login', phone: PHONE });
    expect(res.status).toBe(404);
    expect(mockSendVerificationSms).not.toHaveBeenCalled();
  });
});

describe('presenting a code', () => {
  const registerAndGetCode = async () => {
    await requestCode({ mode: 'register', name: 'Sam Rivera', phone: PHONE });
    return lastCode();
  };

  it('signs in and marks the number verified', async () => {
    const code = await registerAndGetCode();
    const res = await verifyCode({ phone: PHONE, code });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.phoneVerified).toBe(true);
    expect((await User.findByPhone(PHONE)).phoneVerified).toBe(true);
  });

  it('accepts the number however it was punctuated', async () => {
    const code = await registerAndGetCode();
    // The same number a person might reasonably type on a second visit.
    const res = await verifyCode({ phone: '+1 (415) 555-0123', code });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong code and counts it against the lockout', async () => {
    await registerAndGetCode();
    const res = await verifyCode({ phone: PHONE, code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.token).toBeUndefined();
    expect((await User.findByPhone(PHONE)).failedLoginAttempts).toBe(1);
  });

  it('locks the account after repeated wrong codes', async () => {
    await registerAndGetCode();
    for (let i = 0; i < 5; i += 1) await verifyCode({ phone: PHONE, code: '000000' });

    const res = await verifyCode({ phone: PHONE, code: '000000' });
    expect(res.status).toBe(423);
    expect((await User.findByPhone(PHONE)).lockedUntil).toBeTruthy();
  });

  it('rejects an expired code', async () => {
    const code = await registerAndGetCode();
    const user = await User.findByPhone(PHONE);
    await user.update({ phoneVerificationExpires: new Date(Date.now() - 1000) });

    const res = await verifyCode({ phone: PHONE, code });
    expect(res.status).toBe(400);
  });

  it('does not reuse a code once it has been presented', async () => {
    const code = await registerAndGetCode();
    await verifyCode({ phone: PHONE, code });

    const res = await verifyCode({ phone: PHONE, code });
    expect(res.status).toBe(400);
  });

  it('challenges for a second factor instead of issuing a session', async () => {
    const code = await registerAndGetCode();
    await (await User.findByPhone(PHONE)).update({ mfaEnabled: true, mfaSecret: 'x'.repeat(16) });

    const res = await verifyCode({ phone: PHONE, code });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.preAuthToken).toBeTruthy();
    expect(res.body.token).toBeUndefined();
  });
});
