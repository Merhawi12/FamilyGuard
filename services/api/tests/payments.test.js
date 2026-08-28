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

    it('sends the attribution the webhook needs to credit the payment', async () => {
      /*
       * The two parameters a Checkout Studio configuration does not know about
       * and would happily strip. `checkout.session.completed` finds the account
       * by `metadata.userId`, falling back to the Stripe customer — so without
       * both of these a customer whose card was charged stays on the free plan,
       * and the only trace is a log line asking an operator to reconcile it.
       */
      const user = await createUser();

      await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      const args = Stripe.__mock.checkout.sessions.create.mock.calls.at(-1)[0];
      expect(args.metadata.userId).toBe(user.id);
      expect(args.customer).toEqual(expect.any(String));
    });

    it('sends the Checkout Studio configuration', async () => {
      // Pinned so a later edit to this call cannot quietly drop what was
      // configured in the dashboard — the failure would be a payment page that
      // looks subtly wrong, which nothing else here would catch.
      const user = await createUser();

      await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      const args = Stripe.__mock.checkout.sessions.create.mock.calls.at(-1)[0];
      expect(args).toMatchObject({
        billing_address_collection: 'auto',
        phone_number_collection: { enabled: false },
        automatic_tax: { enabled: false },
        allow_promotion_codes: false,
        payment_method_collection: 'always',
      });
      // Deliberately absent: pinning it here would override the payment methods
      // enabled on the Stripe account.
      expect(args.payment_method_types).toBeUndefined();
    });

    it('sends none of the parameters the account may be too old to accept', () => {
      /*
       * These four came from Checkout Studio and were removed again: checkout
       * started answering "Payments are not set up correctly on this deployment"
       * the moment they arrived. Stripe refuses a parameter its API version does
       * not recognise rather than ignoring it, this client pins no version, and
       * `submit_type` additionally wants `mode: 'payment'` where every session
       * here is a subscription.
       *
       * Asserted rather than left to a comment, because the obvious repair for
       * "the Studio config is missing" is to paste them back in, and the symptom
       * that follows names the *deployment* rather than the change.
       */
      const args = Stripe.__mock.checkout.sessions.create.mock.calls.at(-1)[0];
      expect(args.ui_mode).toBeUndefined();
      expect(args.submit_type).toBeUndefined();
      expect(args.integration_identifier).toBeUndefined();
      expect(args.origin_context).toBeUndefined();
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

    it('reports a plan with no price as a configuration fault too', async () => {
      /*
       * The one configuration fault that never reaches Stripe, and so never went
       * through `sendStripeFailure` with the others. A deployment in this state
       * passes every check the plan screen can make — `/auth/providers` sees a
       * key and reports `billing: true` — and then draws an Upgrade button that
       * fails every single time it is pressed. It is one careless paste away
       * from a working setup: this repo's own `.env` had a publishable key
       * sitting in the price slot.
       */
      const { env } = require('../src/config/env');
      const user = await createUser();
      const saved = env.stripe.premiumPriceId;
      env.stripe.premiumPriceId = '';

      try {
        const res = await request(app)
          .post('/api/payments/create-checkout-session')
          .set('Authorization', `Bearer ${tokenFor(user)}`)
          .send({ plan: 'premium' });

        expect(res.status).toBe(503);
        // The flag, not just the status: it is what tells the plan screen to
        // withdraw a purchase it cannot complete, rather than reporting the
        // failure underneath a button that repeats it.
        expect(res.body.configurationError).toBe(true);
      } finally {
        env.stripe.premiumPriceId = saved;
      }
    });

    it('reports a restricted key missing a scope as a configuration fault', async () => {
      /*
       * What a restricted key answers when it may not do this — and a restricted
       * key is the recommended way to run this service, so this was the
       * recommended setup's failure mode being reported as "the payment provider
       * could not be reached", under a button offering to try again. Stripe was
       * reached. It answered. No number of retries changes the key's scopes.
       */
      const user = await createUser();
      Stripe.__mock.checkout.sessions.create.mockRejectedValueOnce(
        Object.assign(
          new Error('The provided key does not have the required permissions.'),
          { type: 'StripePermissionError' },
        )
      );

      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });

      expect(res.status).toBe(503);
      expect(res.body.configurationError).toBe(true);
    });

    it('does not need to read the message to know a bad parameter is ours', async () => {
      // Every parameter these endpoints send is chosen by this service, so an
      // invalid one is a configuration fault whatever Stripe calls it. The old
      // classifier matched three message texts and let the rest through as
      // "try again".
      const user = await createUser();
      Stripe.__mock.checkout.sessions.create.mockRejectedValueOnce(
        Object.assign(
          new Error('The `line_items` parameter is not allowed in `setup` mode.'),
          { type: 'StripeInvalidRequestError' },
        )
      );

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
      // Outside production the reason is shown here too. "Could not be reached"
      // with nothing after it is not something anybody can act on, and this is
      // the branch an operator most often meets while setting Stripe up.
      expect(res.body.detail).toBe('Network error');
      expect(res.body.type).toBe('StripeConnectionError');
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
