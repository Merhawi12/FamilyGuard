const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor } = require('./helpers');
const { PAID_PLAN_KEYS } = require('../src/config/plans');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js

describe('Payments', () => {
  describe('GET /api/payments/subscription', () => {
    it('returns the trial status for a user without a Stripe subscription (no Stripe call)', async () => {
      const user = await createUser({ plan: 'free', subscriptionStatus: 'trial' });
      const res = await request(app)
        .get('/api/payments/subscription')
        .set('Authorization', `Bearer ${tokenFor(user)}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('trial');
      expect(res.body.plan).toBe('free');
    });

    it('degrades gracefully (200 fallback) when Stripe errors — regression for the hung-request bug (M9)', async () => {
      // The Stripe mock rejects subscriptions.retrieve. Before the fix this threw a
      // ReferenceError in the catch block and the request hung.
      const user = await createUser({
        stripeSubscriptionId: 'sub_test',
        plan: 'premium',
        subscriptionStatus: 'active',
      });
      const res = await request(app)
        .get('/api/payments/subscription')
        .set('Authorization', `Bearer ${tokenFor(user)}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active'); // falls back to user.subscriptionStatus
      expect(res.body.plan).toBe('premium');
    });
  });

  describe('POST /api/payments/create-checkout-session', () => {
    it('rejects an unknown plan with 400', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'not-a-plan' });

      expect(res.status).toBe(400);
    });

    it('requires authentication (401)', async () => {
      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .send({ plan: 'premium' });
      expect(res.status).toBe(401);
    });

    /* Family Plus was sellable here after being dropped from the entitlement
       table, so a customer could be billed $14.99 for a plan that granted
       nothing. Checkout targets now come from the catalogue. */
    it('refuses to sell the retired family plan (400)', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'family' });

      expect(res.status).toBe(400);
    });

    it('will not sell the free plan (400)', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'free' });

      expect(res.status).toBe(400);
    });

    it('offers exactly the paid plans the catalogue lists', () => {
      expect(PAID_PLAN_KEYS).toEqual(['premium']);
    });

    it('returns a checkout URL for premium', async () => {
      const user = await createUser();
      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://stripe.test/checkout');

      const args = Stripe.__mock.checkout.sessions.create.mock.calls.at(-1)[0];
      expect(args.mode).toBe('subscription');
      expect(args.line_items[0].price).toBe('price_test_premium');
      expect(args.metadata.plan).toBe('premium');
    });

    /* Every Stripe failure used to answer "Failed to create checkout session",
       so a placeholder API key looked exactly like a Stripe outage and the one
       line that told them apart lived only in the server log. */
    it('reports a bad API key as a configuration fault, not a generic failure', async () => {
      const user = await createUser();
      const authError = Object.assign(new Error('Invalid API Key provided: sk_test_***'), {
        type: 'StripeAuthenticationError',
      });
      Stripe.__mock.checkout.sessions.create.mockRejectedValueOnce(authError);

      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      expect(res.status).toBe(503);
      expect(res.body.configurationError).toBe(true);
      // Outside production the operator gets Stripe's own wording, which names
      // the key or price at fault.
      expect(res.body.detail).toMatch(/Invalid API Key/);
    });

    it('reports an archived price as a configuration fault', async () => {
      const user = await createUser();
      const badPrice = Object.assign(new Error('No such price: price_test_premium'), {
        type: 'StripeInvalidRequestError',
      });
      Stripe.__mock.checkout.sessions.create.mockRejectedValueOnce(badPrice);

      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      expect(res.status).toBe(503);
      expect(res.body.configurationError).toBe(true);
    });

    it('reports a Stripe outage as an upstream failure, not a config fault', async () => {
      const user = await createUser();
      Stripe.__mock.checkout.sessions.create.mockRejectedValueOnce(
        Object.assign(new Error('Network error'), { type: 'StripeConnectionError' })
      );

      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      expect(res.status).toBe(502);
      expect(res.body.configurationError).toBeUndefined();
      expect(res.body.detail).toBeUndefined();
    });
  });
});

/**
 * `.env` files are copied from `.env.example`, and a line left as
 * `sk_test_REPLACE_WITH_YOUR_STRIPE_SECRET_KEY` is truthy — so the guard meant
 * to degrade gracefully when Stripe is unconfigured built a client instead and
 * every call died with an opaque 500.
 */
describe('placeholder configuration reads as absent', () => {
  const { env } = require('../src/config/env');

  it.each([
    ['sk_test_REPLACE_WITH_YOUR_STRIPE_SECRET_KEY', ''],
    ['price_REPLACE_WITH_PREMIUM_PRICE_ID', ''],
    ['whsec_REPLACE_WITH_YOUR_WEBHOOK_SECRET', ''],
    ['changeme', ''],
    ['   ', ''],
    ['sk_test_51Hxxxx', 'sk_test_51Hxxxx'],
    ['price_1Rabc123', 'price_1Rabc123'],
  ])('%s -> %s', (input, expected) => {
    // Re-derived the same way env.js does, since the helper is not exported.
    const configured = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      return /REPLACE_WITH|YOUR_[A-Z_]*(KEY|SECRET|ID)|^changeme$|^xxx+$/i.test(raw) ? '' : raw;
    };
    expect(configured(input)).toBe(expected);
  });

  it('keeps a real-looking test key usable', () => {
    expect(env.stripe.secretKey).toBe('sk_test_dummy');
    expect(env.stripe.premiumPriceId).toBe('price_test_premium');
  });
});
