/**
 * Whether this deployment can take money, reported before anything offers to.
 *
 * The same gap phoneAuthAvailability.test.js was written for, on the plan
 * screen. Every payments test mocks Stripe to get at the logic behind it, so all
 * of them passed while production ran with STRIPE_SECRET_KEY empty: checkout
 * answered 503, and Settings drew "Upgrade to Premium" anyway. The worst version
 * of that is an expired trial, where featureGate has already dropped the account
 * to `free` and the notice tells the parent to upgrade to keep monitoring their
 * family — pointing at the one control guaranteed to fail.
 *
 * So this asserts the flag against real configuration rather than a mock, and
 * asserts the 503 it is meant to predict.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { env } = require('../src/config/env');
const { createUser, tokenFor } = require('./helpers');

/** Runs one assertion with `env.stripe` temporarily set — the object is not frozen. */
const withStripe = async (overrides, fn) => {
  const saved = { ...env.stripe };
  Object.assign(env.stripe, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(env.stripe, saved);
  }
};

describe('Billing availability', () => {
  it('reports billing:false when no Stripe key is configured', async () => {
    await withStripe({ secretKey: '' }, async () => {
      const res = await request(app).get('/api/auth/providers');

      expect(res.status).toBe(200);
      expect(res.body.billing).toBe(false);
    });
  });

  it('reports billing:true once a key is configured', async () => {
    await withStripe({ secretKey: 'sk_test_configured' }, async () => {
      const res = await request(app).get('/api/auth/providers');

      expect(res.body.billing).toBe(true);
    });
  });

  it('is answerable without a session, like the rest of /auth/providers', async () => {
    // The plan screen is behind a login, but the flag describes the deployment
    // rather than the account, and the sign-in page already makes this call.
    const res = await request(app).get('/api/auth/providers');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('billing');
  });

  it('matches what checkout actually does when unconfigured', async () => {
    // The point of the flag: it must predict the 503, not merely coexist with
    // it. `billing` is derived from the same key that decides whether the Stripe
    // client exists at all, which is what keeps the two from drifting.
    const user = await createUser({ email: 'billing-availability@example.com' });
    const token = tokenFor(user);

    const res = await request(app)
      .post('/api/payments/create-checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan: 'premium' });

    const providers = await request(app).get('/api/auth/providers');

    if (providers.body.billing === false) {
      expect(res.status).toBe(503);
    } else {
      expect(res.status).not.toBe(503);
    }
  });
});
