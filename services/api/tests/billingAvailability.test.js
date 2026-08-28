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

/**
 * The other half of "is billing configured": a value that is present and is the
 * wrong kind of thing.
 *
 * Every Stripe credential is an opaque string prefixed with what it is, and the
 * console shows several of them together. This deployment's `.env` had the
 * *publishable* key in `STRIPE_SECRET_KEY` and the same value again in
 * `STRIPE_PREMIUM_PRICE_ID`. Neither can ever work, both are non-empty, and the
 * effect was a deployment advertising `billing: true` and an Upgrade button that
 * could only ever fail — the exact state the tests above exist to prevent,
 * arrived at from the other direction.
 */
describe('a Stripe credential of the wrong kind', () => {
  /** Reads `env` fresh under the given variables, then restores the process. */
  const loadEnv = (vars) => {
    const saved = {};
    for (const [key, value] of Object.entries(vars)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    let loaded;
    jest.isolateModules(() => { loaded = require('../src/config/env').env; });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return loaded;
  };

  const PUBLISHABLE = 'pk_live_51QxAmPleBUTnOTaREALkeyJUSTtheSHAPEofONE';

  it('reads a publishable key in the secret slot as no key at all', () => {
    const loaded = loadEnv({ STRIPE_SECRET_KEY: PUBLISHABLE });

    // Absent, not present-and-broken: `billing` is derived from this, and a
    // deployment that cannot open a checkout must not offer one.
    expect(loaded.stripe.secretKey).toBe('');
    expect(loaded.stripe.problems.join(' ')).toContain('STRIPE_SECRET_KEY');
  });

  it('reads a key pasted into the price slot as no price at all', () => {
    const loaded = loadEnv({ STRIPE_PREMIUM_PRICE_ID: PUBLISHABLE });

    expect(loaded.stripe.premiumPriceId).toBe('');
    expect(loaded.stripe.problems.join(' ')).toContain('STRIPE_PREMIUM_PRICE_ID');
  });

  it('says what was wrong without printing the value', () => {
    const loaded = loadEnv({ STRIPE_SECRET_KEY: PUBLISHABLE });
    const said = loaded.stripe.problems.join(' ');

    // The prefix is the whole of what is wrong with it, and is the half that is
    // not secret. This line goes to the boot log, which is read by more people
    // and kept longer than a `.env`.
    expect(said).toContain('pk_live');
    expect(said).not.toContain(PUBLISHABLE);
  });

  it('accepts every shape that really is one, and reports nothing', () => {
    const loaded = loadEnv({
      STRIPE_SECRET_KEY: 'sk_live_realish',
      STRIPE_WEBHOOK_SECRET: 'whsec_realish',
      STRIPE_PREMIUM_PRICE_ID: 'price_realish',
      STRIPE_FAMILY_PRICE_ID: 'price_legacy',
    });

    expect(loaded.stripe.secretKey).toBe('sk_live_realish');
    expect(loaded.stripe.premiumPriceId).toBe('price_realish');
    expect(loaded.stripe.problems).toEqual([]);
  });

  it('accepts a restricted key, which is the better way to run this', () => {
    // The API only needs checkout, customers and subscriptions — an `rk_` key
    // scoped to those is a smaller blast radius than a full secret key, and
    // must not be rejected as a typo.
    const loaded = loadEnv({ STRIPE_SECRET_KEY: 'rk_live_restricted' });

    expect(loaded.stripe.secretKey).toBe('rk_live_restricted');
    expect(loaded.stripe.problems).toEqual([]);
  });

  it('leaves an unset value alone — unset is a choice, mis-set is a mistake', () => {
    const loaded = loadEnv({
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_PREMIUM_PRICE_ID: '',
      STRIPE_FAMILY_PRICE_ID: '',
    });

    expect(loaded.stripe.secretKey).toBe('');
    expect(loaded.stripe.problems).toEqual([]);
  });
});
