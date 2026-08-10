const request = require('supertest');
const Stripe = require('stripe'); // resolves to the manual mock
const { app } = require('../src/app');
const { User, Transaction } = require('../src/models');
const { createUser } = require('./helpers');

const constructEvent = Stripe.__mock.webhooks.constructEvent;

function postWebhook() {
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'test-sig')
    .send(JSON.stringify({ any: 'payload' }));
}

describe('Stripe webhook', () => {
  it('returns 400 when signature verification fails', async () => {
    constructEvent.mockImplementationOnce(() => { throw new Error('bad signature'); });
    const res = await postWebhook();
    expect(res.status).toBe(400);
  });

  it('activates the plan on checkout.session.completed and is idempotent per event id', async () => {
    const user = await createUser({ plan: 'free', subscriptionStatus: 'trial' });
    const event = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { metadata: { userId: user.id, plan: 'premium' }, subscription: 'sub_123', amount_total: 999, currency: 'usd' } },
    };

    constructEvent.mockReturnValueOnce(event);
    const first = await postWebhook();
    expect(first.status).toBe(200);

    const updated = await User.findByPk(user.id);
    expect(updated.plan).toBe('premium');
    expect(updated.subscriptionStatus).toBe('active');
    expect(updated.stripeSubscriptionId).toBe('sub_123');

    // Replaying the same event id must not create a duplicate transaction.
    constructEvent.mockReturnValueOnce(event);
    const replay = await postWebhook();
    expect(replay.status).toBe(200);

    const txns = await Transaction.findAll({ where: { stripeEventId: 'evt_checkout_1' } });
    expect(txns).toHaveLength(1);
  });

  it('cancels the subscription on customer.subscription.deleted', async () => {
    const user = await createUser({ plan: 'premium', subscriptionStatus: 'active', stripeCustomerId: 'cus_del', stripeSubscriptionId: 'sub_del' });
    constructEvent.mockReturnValueOnce({
      id: 'evt_del_1',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_del' } },
    });

    const res = await postWebhook();
    expect(res.status).toBe(200);

    const updated = await User.findByPk(user.id);
    expect(updated.plan).toBe('free');
    expect(updated.subscriptionStatus).toBe('cancelled');
    expect(updated.stripeSubscriptionId).toBeNull();
  });

  /**
   * Answering 200 to an event we failed to apply tells Stripe the work is done
   * and it is never redelivered — a customer who paid while the database was
   * unreachable would be left on the free plan permanently.
   */
  it('answers 5xx when the handler fails, so Stripe redelivers the event', async () => {
    // A real account, so the failure under test is the transient one being
    // mocked rather than an event that could never be attributed — those are
    // acknowledged deliberately, and are covered below.
    const user = await createUser({ plan: 'free', subscriptionStatus: 'trial' });
    const failing = jest.spyOn(User, 'update').mockRejectedValueOnce(new Error('database is unreachable'));

    constructEvent.mockReturnValueOnce({
      id: 'evt_retry_1',
      type: 'checkout.session.completed',
      data: { object: { metadata: { userId: user.id, plan: 'premium' }, subscription: 'sub_retry', amount_total: 999, currency: 'usd' } },
    });

    const res = await postWebhook();

    failing.mockRestore();
    expect(res.status).toBe(500);
  });

  /**
   * Not every subscription starts at `create-checkout-session`. A Stripe payment
   * link, the Buy Button and a subscription started from the dashboard all send
   * this event with no metadata, which used to throw inside the handler — so
   * Stripe redelivered it for three days while the customer who had paid sat on
   * the free plan.
   */
  describe('a checkout that carries no metadata', () => {
    it('attributes it by Stripe customer and activates the plan', async () => {
      const user = await createUser({ plan: 'free', subscriptionStatus: 'trial', stripeCustomerId: 'cus_link_1' });

      constructEvent.mockReturnValueOnce({
        id: 'evt_link_1',
        type: 'checkout.session.completed',
        data: { object: { customer: 'cus_link_1', subscription: 'sub_link_1', amount_total: 999, currency: 'usd' } },
      });

      expect((await postWebhook()).status).toBe(200);

      const updated = await User.findByPk(user.id);
      expect(updated.plan).toBe('premium');
      expect(updated.subscriptionStatus).toBe('active');
      expect(updated.stripeSubscriptionId).toBe('sub_link_1');
    });

    it('records the payment against the account it found', async () => {
      const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_link_2' });

      constructEvent.mockReturnValueOnce({
        id: 'evt_link_2',
        type: 'checkout.session.completed',
        data: { object: { customer: 'cus_link_2', subscription: 'sub_link_2', amount_total: 1499, currency: 'usd' } },
      });
      expect((await postWebhook()).status).toBe(200);

      const txns = await Transaction.findAll({ where: { userId: user.id } });
      expect(txns).toHaveLength(1);
      expect(txns[0].amount).toBe(1499);
    });

    it('acknowledges an event it cannot attribute rather than looping forever', async () => {
      // No metadata and a customer that belongs to no account. Redelivery can
      // never supply what is missing, so 200 is the only answer that terminates.
      constructEvent.mockReturnValueOnce({
        id: 'evt_link_orphan',
        type: 'checkout.session.completed',
        data: { object: { customer: 'cus_nobody', subscription: 'sub_x', amount_total: 999, currency: 'usd' } },
      });
      expect((await postWebhook()).status).toBe(200);

      constructEvent.mockReturnValueOnce({
        id: 'evt_link_empty',
        type: 'checkout.session.completed',
        data: { object: { metadata: {}, subscription: 'sub_y', amount_total: 999, currency: 'usd' } },
      });
      expect((await postWebhook()).status).toBe(200);
    });
  });

  it('recovers on the redelivery once the failure clears', async () => {
    const user = await createUser({ plan: 'free', subscriptionStatus: 'trial' });
    const event = {
      id: 'evt_retry_2',
      type: 'checkout.session.completed',
      data: { object: { metadata: { userId: user.id, plan: 'premium' }, subscription: 'sub_retry_2', amount_total: 999, currency: 'usd' } },
    };

    const failing = jest.spyOn(User, 'update').mockRejectedValueOnce(new Error('database is unreachable'));
    constructEvent.mockReturnValueOnce(event);
    expect((await postWebhook()).status).toBe(500);
    failing.mockRestore();

    constructEvent.mockReturnValueOnce(event);
    expect((await postWebhook()).status).toBe(200);

    const updated = await User.findByPk(user.id);
    expect(updated.plan).toBe('premium');
  });
});
