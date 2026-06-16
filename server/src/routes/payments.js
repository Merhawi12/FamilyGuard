const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { User } = require('../models');
const { authenticate } = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  premium: { priceId: process.env.STRIPE_PREMIUM_PRICE_ID, name: 'Premium', amount: 999 },
  family:  { priceId: process.env.STRIPE_FAMILY_PRICE_ID,  name: 'Family Plus', amount: 1499 },
};

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', authenticate, async (req, res) => {
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
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata;
        await User.update(
          { plan, stripeSubscriptionId: session.subscription, subscriptionStatus: 'active' },
          { where: { id: userId } }
        );
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          const plan = sub.items.data[0]?.price?.id === process.env.STRIPE_FAMILY_PRICE_ID ? 'family' : 'premium';
          await user.update({ subscriptionStatus: sub.status, plan });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          await user.update({ plan: 'free', stripeSubscriptionId: null, subscriptionStatus: 'cancelled' });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: invoice.customer } });
        if (user) await user.update({ subscriptionStatus: 'past_due' });
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
