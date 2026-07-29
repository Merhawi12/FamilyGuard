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
});
