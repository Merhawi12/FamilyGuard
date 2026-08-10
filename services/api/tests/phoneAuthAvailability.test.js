/**
 * Whether phone sign-in can be reached at all, which is a separate question
 * from whether the controller's logic is right once it is.
 *
 * `tests/phoneAuth.test.js` covers the second and mocks the SMS module to `true`
 * to get there. That mock is also why the first went unnoticed: with no
 * credentials anywhere — no local `.env`, no Terraform secret, no Cloud Run
 * variable — `/auth/providers` answered `phone: false`, the Family App hid the
 * Phone tab, and the entire identifier was unreachable in every environment
 * that existed while 603 tests passed.
 *
 * So these tests deliberately do NOT mock the SMS module. They exercise the
 * real `isEnabled`/`canVerifyByPhone` against real configuration.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { env } = require('../src/config/env');
const { User } = require('../src/models');
const sms = require('../src/services/sms');

const PHONE = '+14155550188';

/** Runs one assertion with `env.sms` temporarily set — the object is not frozen. */
const withSms = async (overrides, fn) => {
  const saved = { ...env.sms };
  Object.assign(env.sms, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(env.sms, saved);
  }
};

beforeEach(async () => {
  await User.destroy({ where: {}, force: true });
});

describe('the sign-in page is told whether phone sign-in can be finished', () => {
  it('hides the Phone tab when nothing can send or show a code', async () => {
    // Production with no credentials: a code that cannot be sent is a sign-in
    // that cannot be finished, so the door is not drawn.
    await withSms({ provider: 'none', accountSid: '', authToken: '', echoCode: false }, async () => {
      const res = await request(app).get('/api/auth/providers');
      expect(res.body.phone).toBe(false);
    });
  });

  it('offers the Phone tab when a real provider is configured', async () => {
    await withSms(
      { provider: 'twilio', accountSid: 'AC-test', authToken: 'tok', from: '+15550000000', echoCode: false },
      async () => {
        const res = await request(app).get('/api/auth/providers');
        expect(res.body.phone).toBe(true);
      }
    );
  });

  /**
   * The regression that made this file necessary. Development has no SMS
   * credentials and never will, so gating the tab on `isEnabled()` alone meant
   * the flow could not be started on the one machine anyone develops on.
   */
  it('offers the Phone tab in development, where the code comes back in the response', async () => {
    await withSms({ provider: 'none', accountSid: '', authToken: '', echoCode: true }, async () => {
      const res = await request(app).get('/api/auth/providers');
      expect(res.body.phone).toBe(true);
    });
  });
});

describe('the code, when there is no provider to send it with', () => {
  it('comes back in the response so the flow can be finished', async () => {
    await withSms({ provider: 'none', accountSid: '', authToken: '', echoCode: true }, async () => {
      const res = await request(app)
        .post('/api/auth/phone/request')
        .send({ mode: 'register', name: 'Dev Parent', phone: PHONE });

      expect(res.status).toBe(200);
      expect(res.body.smsDelivered).toBe(false);
      expect(res.body.devCode).toMatch(/^\d{6}$/);

      // And it is the real code, not a decoration: presenting it signs in.
      const verify = await request(app)
        .post('/api/auth/phone/verify')
        .send({ phone: PHONE, code: res.body.devCode });

      expect(verify.status).toBe(200);
      expect(verify.body.token).toBeTruthy();
      expect(verify.body.user.phone).toBe(PHONE);
      expect(verify.body.user.phoneVerified).toBe(true);
    });
  });

  it('is never returned once a provider is configured', async () => {
    // The echo is for the case where there is nowhere else for the code to go.
    // A deployment that can text it must not also publish it in a response body.
    await withSms(
      { provider: 'twilio', accountSid: 'AC-test', authToken: 'tok', from: '+15550000000', echoCode: false },
      async () => {
        const res = await request(app)
          .post('/api/auth/phone/request')
          .send({ mode: 'register', name: 'Dev Parent', phone: PHONE });

        expect(res.body.devCode).toBeUndefined();
      }
    );
  });

  it('is not returned when the echo is off, whatever else is true', async () => {
    await withSms({ provider: 'none', accountSid: '', authToken: '', echoCode: false }, async () => {
      const res = await request(app)
        .post('/api/auth/phone/request')
        .send({ mode: 'register', name: 'Dev Parent', phone: PHONE });

      expect(res.status).toBe(200);
      expect(res.body.smsDelivered).toBe(false);
      expect(res.body.devCode).toBeUndefined();
    });
  });
});

/**
 * The suite's own blind spot, asserted directly.
 *
 * `phoneAuth.test.js` replaces this module with a hand-written object. When the
 * controller started importing `canVerifyByPhone`, that mock would have supplied
 * `undefined` and the endpoint would have thrown — in production, behind a green
 * run. Pinning the shape means the next export added to the real module fails
 * here, where the reason is obvious, rather than there.
 */
describe('the SMS module exposes what the controller imports', () => {
  it('exports send, isEnabled, canVerifyByPhone and sendVerificationSms', () => {
    for (const name of ['send', 'isEnabled', 'canVerifyByPhone', 'sendVerificationSms']) {
      expect(typeof sms[name]).toBe('function');
    }
  });

  it('reports delivery and reachability as separate questions', () => {
    // The distinction the whole fix rests on: nothing can be sent, yet the flow
    // is reachable, because the code has somewhere else to go.
    withSms({ provider: 'none', accountSid: '', authToken: '', echoCode: true }, () => {
      expect(sms.isEnabled()).toBe(false);
      expect(sms.canVerifyByPhone()).toBe(true);
    });
  });
});
