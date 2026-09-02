const request = require('supertest');
const { app } = require('../src/app');
const { User, Transaction } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js

/**
 * A customer who has paid ends up on the plan they paid for.
 *
 * Until now that depended entirely on `checkout.session.completed`. It is the
 * right authority for everything that happens away from a browser — a renewal, a
 * card that fails next month, a cancellation from the portal — and the wrong
 * single point of failure for the one moment somebody is watching the screen:
 * with `STRIPE_WEBHOOK_SECRET` unset, every delivery fails signature
 * verification and the handler never runs. Nothing refused to start over that,
 * nothing warned about it, and the plan screen printed "Payment successful —
 * your plan has been upgraded" from a query string regardless. Charged,
 * congratulated, still on Free.
 *
 * So the return from Checkout now grants the plan too, and these are the
 * properties that make that safe to do:
 *
 *   - Stripe decides, not the browser. A session id in a URL proves nothing.
 *   - The session must belong to the account asking, or it is a way to buy
 *     Premium with somebody else's card.
 *   - Running twice — a refresh, a retry, and the webhook arriving late — must
 *     leave one upgraded account and one recorded sale, not two.
 */

const sessions = Stripe.__mock.checkout.sessions;
const DEFAULT_SESSION = {
  id: 'cs_test', status: 'complete', payment_status: 'paid',
  customer: 'cus_test', subscription: 'sub_test',
  amount_total: 999, currency: 'cad', metadata: {},
};

/** Makes the next retrieve answer with this session. */
const stripeReturns = (overrides) => {
  sessions.retrieve.mockImplementation(async (id) => ({ ...DEFAULT_SESSION, id, ...overrides }));
};

/**
 * A fresh session id per test.
 *
 * The sale is keyed on the session, which is the whole point of the idempotency
 * below — so a shared literal would make the *second* test in the file collide
 * with the first's row and see no transaction at all. Tests that mean to repeat
 * a session pass the id explicitly.
 */
let sessionCounter = 0;
const nextSessionId = () => `cs_test_${sessionCounter += 1}`;

const confirm = (user, sessionId = nextSessionId()) => request(app)
  .post('/api/payments/checkout/confirm')
  .set('Authorization', `Bearer ${tokenFor(user)}`)
  .send({ sessionId });

/** A free account that has been through Checkout, so it owns `cus_test`. */
const buyer = (overrides) => createUser({
  plan: 'free', stripeCustomerId: 'cus_test', subscriptionStatus: 'trial', ...overrides,
});

beforeEach(() => {
  sessions.retrieve.mockClear();
  stripeReturns({});
});

describe('Returning from Checkout', () => {
  it('upgrades the account and hands back the account it upgraded', async () => {
    const user = await buyer();

    const res = await confirm(user);

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.plan).toBe('premium');
    // Returned so the plan screen can update without a second round trip.
    expect(res.body.user.plan).toBe('premium');

    await user.reload();
    expect(user.plan).toBe('premium');
    expect(user.subscriptionStatus).toBe('active');
    expect(user.stripeSubscriptionId).toBe('sub_test');
  });

  it('records the sale, so the console reports it', async () => {
    const user = await buyer();
    await confirm(user);

    const rows = await Transaction.findAll({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('checkout_completed');
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].amount).toBe(999);
  });

  it('honours the plan the session was created for', async () => {
    const user = await buyer();
    stripeReturns({ metadata: { plan: 'premium', userId: user.id } });

    const res = await confirm(user);
    expect(res.body.plan).toBe('premium');
  });

  /**
   * The property that makes it safe to run this beside the webhook rather than
   * instead of it.
   */
  it('is idempotent — a refresh does not bill or upgrade twice', async () => {
    const user = await buyer();
    // The same session three times, which is exactly what a browser refresh on
    // the success URL does.
    const sessionId = nextSessionId();

    await confirm(user, sessionId);
    await confirm(user, sessionId);
    await confirm(user, sessionId);

    await user.reload();
    expect(user.plan).toBe('premium');

    const rows = await Transaction.findAll({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });
});

describe('A session that is not this account\'s', () => {
  it('is refused, and does not upgrade anybody', async () => {
    const attacker = await createUser({ plan: 'free', stripeCustomerId: 'cus_someone_else' });
    // Belongs to cus_test, and carries another account's id in its metadata.
    stripeReturns({ customer: 'cus_test', metadata: { userId: 'a-different-user' } });

    const res = await confirm(attacker);

    expect(res.status).toBe(403);
    await attacker.reload();
    expect(attacker.plan).toBe('free');
    expect(await Transaction.count({ where: { userId: attacker.id } })).toBe(0);
  });

  it('accepts a session identified by metadata alone, before a customer is stored', async () => {
    // A session created for this user, on an account whose stripeCustomerId has
    // not been written back yet. The metadata is this service's own record of
    // who it was for, so it is enough.
    const user = await createUser({ plan: 'free', stripeCustomerId: null });
    stripeReturns({ customer: 'cus_unknown', metadata: { userId: user.id } });

    const res = await confirm(user);
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
  });
});

describe('A session that is not paid', () => {
  it('reports it as pending rather than granting or failing', async () => {
    const user = await buyer();
    stripeReturns({ status: 'complete', payment_status: 'unpaid' });

    const res = await confirm(user);

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(false);
    expect(res.body.pending).toBe(true);

    await user.reload();
    expect(user.plan).toBe('free');
  });

  it('grants a session that completed with nothing to pay', async () => {
    // A full-discount coupon completes and owes nothing. Refusing the plan there
    // would be refusing a sale the business made.
    const user = await buyer();
    stripeReturns({ payment_status: 'no_payment_required' });

    const res = await confirm(user);
    expect(res.body.activated).toBe(true);
  });

  it('does not grant an abandoned session', async () => {
    const user = await buyer();
    stripeReturns({ status: 'open', payment_status: 'unpaid' });

    const res = await confirm(user);
    expect(res.body.activated).toBe(false);
    await user.reload();
    expect(user.plan).toBe('free');
  });
});

describe('The shape of the request', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/payments/checkout/confirm')
      .send({ sessionId: 'cs_test_123' });

    expect(res.status).toBe(401);
  });

  it('refuses a value that is not a Checkout session id, without calling Stripe', async () => {
    const user = await buyer();

    for (const sessionId of ['', 'sub_123', 'not-an-id', 42, null]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await confirm(user, sessionId);
      expect(res.status).toBe(400);
    }
    expect(sessions.retrieve).not.toHaveBeenCalled();
  });
});

describe('The webhook and the return agree', () => {
  /**
   * Both paths key the sale on the session rather than on their own identifier,
   * so a webhook arriving after the customer has already been served does not
   * add a second row and double-count the month's revenue.
   */
  it('does not record the sale twice when the webhook lands afterwards', async () => {
    const user = await buyer();
    const sessionId = nextSessionId();
    await confirm(user, sessionId);

    // The same session, arriving the other way a few seconds later.
    Stripe.__mock.webhooks.constructEvent.mockReturnValueOnce({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { ...DEFAULT_SESSION, id: sessionId, metadata: { userId: user.id } } },
    });

    const res = await request(app)
      .post('/api/payments/webhook')
      .set('stripe-signature', 'test')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);

    const rows = await Transaction.findAll({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);

    await user.reload();
    expect(user.plan).toBe('premium');
  });
});

describe('When the deployment cannot sell', () => {
  it('never claims billing is available on a key with no price', async () => {
    const { env } = require('../src/config/env');
    const saved = env.stripe.premiumPriceId;
    env.stripe.premiumPriceId = '';
    try {
      const res = await request(app).get('/api/auth/providers');
      // The whole point: a key alone used to answer `true` here, the plan screen
      // drew "Upgrade to Premium", and pressing it got a 503 from the price
      // check — a button withdrawn only after it had already failed once.
      expect(res.body.billing).toBe(false);

      const user = await createUser();
      const checkout = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .send({ plan: 'premium' });
      expect(checkout.status).toBe(503);
      expect(checkout.body.configurationError).toBe(true);
    } finally {
      env.stripe.premiumPriceId = saved;
    }
  });
});

describe('What the operator is told at boot', () => {
  const { billingGaps } = require('../src/services/billing');
  const { env } = require('../src/config/env');

  const withStripe = (overrides, fn) => {
    const saved = { ...env.stripe };
    Object.assign(env.stripe, overrides);
    try { return fn(); } finally { Object.assign(env.stripe, saved); }
  };

  it('says nothing when Stripe is configured end to end', () => {
    withStripe({ secretKey: 'sk_test_x', premiumPriceId: 'price_x', webhookSecret: 'whsec_x' }, () => {
      expect(billingGaps()).toEqual([]);
    });
  });

  it('names the missing price, which is what silently withdraws the sale', () => {
    withStripe({ secretKey: 'sk_test_x', premiumPriceId: '', webhookSecret: 'whsec_x' }, () => {
      expect(billingGaps().join(' ')).toMatch(/PRICE_ID/);
    });
  });

  /**
   * The one that had no symptom anywhere. A missing webhook secret does not stop
   * a payment — it stops every renewal, cancellation and failed card from ever
   * reaching this API, and until now no line of output said so.
   */
  it('names the missing webhook secret', () => {
    withStripe({ secretKey: 'sk_test_x', premiumPriceId: 'price_x', webhookSecret: '' }, () => {
      expect(billingGaps().join(' ')).toMatch(/WEBHOOK_SECRET/);
    });
  });

  it('does not nag about a webhook secret on a deployment with no Stripe at all', () => {
    withStripe({ secretKey: '', premiumPriceId: '', webhookSecret: '' }, () => {
      expect(billingGaps().join(' ')).not.toMatch(/WEBHOOK_SECRET/);
    });
  });
});
