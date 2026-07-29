const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor } = require('./helpers');

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
  });
});
