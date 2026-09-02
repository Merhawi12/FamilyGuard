const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor } = require('./helpers');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js

/**
 * A stored Stripe customer that Stripe does not have.
 *
 * `users.stripeCustomerId` is a foreign key into somebody else's database, and
 * it can stop resolving without a line of this code changing: the deployment's
 * key is rolled to a different Stripe account, an account moves between test
 * and live mode, or a customer is deleted from the dashboard. The id stays on
 * the row, and every later call carries it.
 *
 * Production met this as
 *
 *   StripeInvalidRequestError / resource_missing
 *   No such customer: 'cus_V9bGIsYwyG7Y4a'
 *
 * and the shape of the failure is what made it worth fixing in code. It is a
 * `StripeInvalidRequestError`, so it landed in `RETRY_WILL_NOT_HELP`, came back
 * as a 503 with `configurationError: true`, and the plan screen withdrew the
 * Upgrade button. That verdict was right that retrying would not help and wrong
 * about whose problem it was: nothing was misconfigured — `/auth/providers`
 * reported `billing: true` and it was telling the truth — and no amount of
 * fixing the deployment would have helped, because the dead id was on one
 * user's row. That account could never subscribe again, and the vanishing
 * button told them the whole platform could not take payments.
 */

const customers = Stripe.__mock.customers;
const checkoutSessions = Stripe.__mock.checkout.sessions;
const portalSessions = Stripe.__mock.billingPortal.sessions;

/** The error Stripe really returns for an id from another account. */
const noSuchCustomer = (id) => Object.assign(
  new Error(`No such customer: '${id}'`),
  { type: 'StripeInvalidRequestError', code: 'resource_missing', param: 'customer' }
);

/** Rejects for any customer except `goodId`, the way a rolled key behaves. */
const onlyKnows = (goodId, fn) => fn.mockImplementation(async ({ customer }) => {
  if (customer !== goodId) throw noSuchCustomer(customer);
  return { id: 'cs_fresh', url: 'https://stripe.test/checkout' };
});

let created = 0;
beforeEach(() => {
  created = 0;
  // `mockImplementation` replaces behaviour and keeps the call log, and half of
  // what is asserted here is *how many times* Stripe was called — so the counts
  // have to be cleared as well, or every test inherits the last one's.
  customers.create.mockClear();
  checkoutSessions.create.mockClear();
  portalSessions.create.mockClear();

  customers.create.mockImplementation(async () => {
    created += 1;
    return { id: `cus_fresh_${created}` };
  });
  checkoutSessions.create.mockImplementation(async () => ({ id: 'cs_test', url: 'https://stripe.test/checkout' }));
  portalSessions.create.mockImplementation(async () => ({ url: 'https://stripe.test/portal' }));
});

afterAll(() => {
  // Put the shared mock back the way the other suites expect to find it.
  customers.create.mockImplementation(async () => ({ id: 'cus_test' }));
  checkoutSessions.create.mockImplementation(async () => ({ id: 'cs_test', url: 'https://stripe.test/checkout' }));
  portalSessions.create.mockImplementation(async () => ({ url: 'https://stripe.test/portal' }));
});

const checkout = (user) => request(app)
  .post('/api/payments/create-checkout-session')
  .set('Authorization', `Bearer ${tokenFor(user)}`)
  .send({ plan: 'premium' });

describe('Checking out with a customer id Stripe no longer has', () => {
  it('replaces it and opens checkout, instead of a permanent 503', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_from_another_account' });
    onlyKnows('cus_fresh_1', checkoutSessions.create);

    const res = await checkout(user);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://stripe.test/checkout');

    // The dead id is gone from the row, so the next attempt does not repeat the
    // round trip that failed.
    await user.reload();
    expect(user.stripeCustomerId).toBe('cus_fresh_1');
  });

  it('creates exactly one replacement, and retries exactly once', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_gone' });
    onlyKnows('cus_fresh_1', checkoutSessions.create);

    await checkout(user);

    expect(customers.create).toHaveBeenCalledTimes(1);
    expect(checkoutSessions.create).toHaveBeenCalledTimes(2);
  });

  /**
   * One retry, not a loop. A customer this service has just created and been
   * handed back cannot also be missing, so a second `resource_missing` is a real
   * fault and must surface rather than spin.
   */
  it('gives up after one retry rather than looping', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_gone' });
    checkoutSessions.create.mockImplementation(async ({ customer }) => {
      throw noSuchCustomer(customer);
    });

    const res = await checkout(user);

    expect(res.status).toBe(503);
    expect(res.body.configurationError).toBe(true);
    expect(customers.create).toHaveBeenCalledTimes(1);
    expect(checkoutSessions.create).toHaveBeenCalledTimes(2);
  });

  it('leaves an account with no customer at all on the path it always took', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: null });

    const res = await checkout(user);

    expect(res.status).toBe(200);
    expect(customers.create).toHaveBeenCalledTimes(1);
    // No wasted first attempt: there was nothing stale to discover.
    expect(checkoutSessions.create).toHaveBeenCalledTimes(1);
    await user.reload();
    expect(user.stripeCustomerId).toBe('cus_fresh_1');
  });

  it('does not touch a customer that works', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_still_good' });
    onlyKnows('cus_still_good', checkoutSessions.create);

    const res = await checkout(user);

    expect(res.status).toBe(200);
    expect(customers.create).not.toHaveBeenCalled();
    await user.reload();
    expect(user.stripeCustomerId).toBe('cus_still_good');
  });

  /**
   * Only the customer is recovered from. Every other `resource_missing` — an
   * archived price, most obviously — is a genuine configuration fault, and
   * quietly minting a new customer for it would hide it behind a second
   * identical failure.
   */
  it('does not retry a resource_missing that is not the customer', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_still_good' });
    checkoutSessions.create.mockImplementation(async () => {
      throw Object.assign(new Error("No such price: 'price_gone'"), {
        type: 'StripeInvalidRequestError', code: 'resource_missing', param: 'line_items[0][price]',
      });
    });

    const res = await checkout(user);

    expect(res.status).toBe(503);
    expect(customers.create).not.toHaveBeenCalled();
    expect(checkoutSessions.create).toHaveBeenCalledTimes(1);
  });
});

describe('Opening the billing portal with a dead customer id', () => {
  const portal = (user) => request(app)
    .post('/api/payments/customer-portal')
    .set('Authorization', `Bearer ${tokenFor(user)}`);

  it('recovers, so cancelling is not the moment this fails', async () => {
    const user = await createUser({ plan: 'premium', stripeCustomerId: 'cus_gone' });
    portalSessions.create.mockImplementation(async ({ customer }) => {
      if (customer !== 'cus_fresh_1') throw noSuchCustomer(customer);
      return { url: 'https://stripe.test/portal' };
    });

    const res = await portal(user);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://stripe.test/portal');
  });

  it('still refuses an account that has never had a subscription', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: null });

    const res = await portal(user);

    // The portal manages an existing subscription; minting a customer to open an
    // empty one would be answering a question nobody asked.
    expect(res.status).toBe(400);
    expect(customers.create).not.toHaveBeenCalled();
  });
});
