const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { User, Transaction } = require('../models');
const { authenticate } = require('../middleware/auth');

// A misconfigured/missing Stripe key must not crash the whole API — payments
// degrade to 503 while every other route (alerts, location, monitoring) stays up.
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) console.error('[payments] STRIPE_SECRET_KEY not set — payment routes disabled');

const PLANS = {
  premium: { priceId: process.env.STRIPE_PREMIUM_PRICE_ID, name: 'Premium', amount: 999 },
  family:  { priceId: process.env.STRIPE_FAMILY_PRICE_ID,  name: 'Family Plus', amount: 1499 },
};

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });

  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const user = await User.findByPk(req.user.id);

    // Create or reuse Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name });
      customerId = customer.id;
      await user.update({ stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.CLIENT_URL}/dashboard/settings?payment=success`,
      cancel_url:  `${process.env.CLIENT_URL}/dashboard/settings?payment=cancelled`,
      metadata: { userId: user.id, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/payments/customer-portal
router.post('/customer-portal', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });

  try {
    const user = await User.findByPk(req.user.id);
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'No active subscription' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.CLIENT_URL}/dashboard/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// GET /api/payments/subscription
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user.stripeSubscriptionId) {
      return res.json({ status: user.subscriptionStatus || 'trial', plan: user.plan });
    }

    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    res.json({
      status: subscription.status,
      plan: user.plan,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
  } catch (err) {
    res.json({ status: user?.subscriptionStatus || 'trial', plan: user?.plan });
  }
});

// POST /api/payments/webhook  (raw body — registered before JSON middleware)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('Payments are not configured');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const recordTransaction = async (data) => {
    try {
      await Transaction.create({ ...data, stripeEventId: event.id });
    } catch (err) {
      if (!err.message?.includes('UNIQUE')) console.error('Transaction log error:', err.message);
    }
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;
        await User.update(
          { plan, stripeSubscriptionId: session.subscription, subscriptionStatus: 'active' },
          { where: { id: userId } }
        );
        await recordTransaction({
          userId, type: 'checkout_completed', plan, status: 'succeeded',
          amount: session.amount_total, currency: session.currency,
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          const plan = sub.items.data[0]?.price?.id === process.env.STRIPE_FAMILY_PRICE_ID ? 'family' : 'premium';
          await user.update({ subscriptionStatus: sub.status, plan });
          await recordTransaction({ userId: user.id, type: 'subscription_updated', plan, status: sub.status });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          await user.update({ plan: 'free', stripeSubscriptionId: null, subscriptionStatus: 'cancelled' });
          await recordTransaction({ userId: user.id, type: 'subscription_cancelled', plan: 'free', status: 'cancelled' });
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: invoice.customer } });
        if (user) {
          await recordTransaction({
            userId: user.id, type: 'invoice_paid', plan: user.plan, status: 'succeeded',
            amount: invoice.amount_paid, currency: invoice.currency,
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: invoice.customer } });
        if (user) {
          await user.update({ subscriptionStatus: 'past_due' });
          await recordTransaction({
            userId: user.id, type: 'invoice_failed', plan: user.plan, status: 'failed',
            amount: invoice.amount_due, currency: invoice.currency,
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
