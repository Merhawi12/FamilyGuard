const express = require('express');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const router = express.Router();
const { User, Transaction } = require('../models');
const { authenticate } = require('../middleware/auth');
const { PLANS: PLAN_CATALOGUE, PAID_PLAN_KEYS } = require('../config/plans');
// A misconfigured/missing Stripe key must not crash the whole API — payments
// degrade to 503 while every other route (alerts, location, monitoring) stays up.
// The client itself lives in services/billing, because closing an account needs
// it too and two clients would be two connection pools.
const { stripe } = require('../services/billing');

// Checkout targets, derived from the catalogue so a plan cannot be sellable
// here and absent there — the mismatch that let `family` outlive its removal
// from the entitlement table and bill for features nothing granted.
const CHECKOUT_PLANS = Object.fromEntries(
  PAID_PLAN_KEYS.map((key) => [key, {
    name: PLAN_CATALOGUE[key].label,
    amount: PLAN_CATALOGUE[key].amount,
  }])
);

/**
 * The Stripe price a plan sells at, read when it is needed rather than copied
 * into the map above at import.
 *
 * The map used to carry it, which made the price this file believed in a
 * snapshot of the configuration as it stood when the module was first required.
 * Nothing in production changes it afterwards, so that was harmless there and
 * quietly awkward everywhere else: it is why the "plan with no price" branch
 * could not be reached without resetting the module graph, and the same reason
 * `billingAvailability.test.js` can vary `env.stripe` and this could not.
 * Reading it here costs one property lookup on a path that is about to make an
 * HTTPS request to Stripe.
 */
const priceIdFor = (key) => env.stripe[PLAN_CATALOGUE[key].priceEnv];

/**
 * Which plan a Stripe price grants.
 *
 * Premium is the only tier sold, so any live subscription entitles the account
 * to it — including the retired $14.99 Family Plus price, which grandfathered
 * customers still bill against. Their entitlements come from Premium (it
 * absorbed every Family Plus feature); only the amount they pay is legacy.
 *
 * An unrecognised price still resolves to Premium, because a subscription
 * exists and refusing to name a plan would leave a paying customer with none —
 * but it is logged, since it means a Stripe price nobody configured here.
 */
const planForPrice = (priceId) => {
  const known = PAID_PLAN_KEYS.find((key) => priceId && priceIdFor(key) === priceId);
  if (known) return known;
  if (priceId && priceId !== env.stripe.legacyFamilyPriceId) {
    logger.warn('Stripe subscription on an unrecognised price — defaulting to premium', { priceId });
  }
  return 'premium';
};

/**
 * Turns a Stripe exception into a status and a message worth reading.
 *
 * "Failed to create checkout session" was the answer to every failure, so a
 * placeholder API key, an archived price and a genuine Stripe outage were
 * indistinguishable from the browser — and the one line that could tell them
 * apart only existed in the server log. A misconfiguration is the operator's
 * problem, not the customer's, and saying so is what makes it fixable.
 *
 * Stripe's own message is passed through only for configuration faults, which
 * are about this deployment's setup and carry no customer data. Everything else
 * gets a generic message and a full log line.
 */
const sendStripeFailure = (res, err, context) => {
  const configFault = err?.type === 'StripeAuthenticationError'
    || (err?.type === 'StripeInvalidRequestError' && /No such price|No such plan|not.*recurring/i.test(err.message || ''));

  logger.error('Stripe request failed', { ...context, type: err?.type, code: err?.code, error: err?.message });

  if (configFault) {
    return res.status(503).json({
      error: 'Payments are not set up correctly on this deployment. Please contact support.',
      configurationError: true,
      // Stripe's wording names the exact key or price at fault, which is what
      // makes it fixable — but it describes our infrastructure, so a customer
      // in production never sees it. Locally it is the whole point.
      ...(env.isProduction ? {} : { detail: err.message }),
    });
  }

  return res.status(502).json({ error: 'The payment provider could not be reached. Please try again.' });
};

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });

  const { plan } = req.body;
  if (!CHECKOUT_PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  if (!priceIdFor(plan)) {
    // A plan with no Stripe price would send the customer to a checkout that
    // fails on Stripe's side with nothing to explain it.
    //
    // Flagged as a configuration fault like the Stripe failures below, because
    // that is exactly what it is — and the flag is what tells the plan screen to
    // stop offering a purchase it cannot complete. Without it this branch was
    // the one way to reach a permanently-failing Upgrade button that survived
    // being pressed: a key good enough to pass `/auth/providers` plus a price ID
    // that is missing or the wrong kind of value, which is one careless paste
    // apart from a working setup.
    logger.error('Checkout attempted for a plan with no Stripe price configured', { plan });
    return res.status(503).json({
      error: 'That plan is not available for purchase right now',
      configurationError: true,
    });
  }

  try {
    const user = await User.findByPk(req.user.id);

    // Create or reuse Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      // `email` is omitted rather than sent as null for a phone-only account:
      // Stripe treats an explicit null as "clear it", and a customer with no
      // address simply has no receipt destination until one is added.
      const customer = await stripe.customers.create({
        name: user.name,
        ...(user.email ? { email: user.email } : {}),
      });
      customerId = customer.id;
      await user.update({ stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceIdFor(plan), quantity: 1 }],
      mode: 'subscription',
      success_url: `${env.clientUrl}/dashboard/settings?payment=success`,
      cancel_url:  `${env.clientUrl}/dashboard/settings?payment=cancelled`,
      metadata: { userId: user.id, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    return sendStripeFailure(res, err, { where: 'checkout', plan });
  }
  return undefined;
});

// POST /api/payments/customer-portal
router.post('/customer-portal', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });

  try {
    const user = await User.findByPk(req.user.id);
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'No active subscription' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${env.clientUrl}/dashboard/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    return sendStripeFailure(res, err, { where: 'billing_portal' });
  }
  return undefined;
});

// GET /api/payments/subscription
router.get('/subscription', authenticate, async (req, res) => {
  let user;
  try {
    user = await User.findByPk(req.user.id);
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
    event = stripe.webhooks.constructEvent(req.body, sig, env.stripe.webhookSecret);
  } catch (err) {
    logger.error('Stripe webhook signature rejected', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const recordTransaction = async (data) => {
    try {
      await Transaction.create({ ...data, stripeEventId: event.id });
    } catch (err) {
      // A duplicate stripeEventId (already-processed event) surfaces as a
      // SequelizeUniqueConstraintError whose message is just "Validation error" —
      // check the error type, not the text, so real failures still get logged.
      if (err.name !== 'SequelizeUniqueConstraintError') logger.error('Failed to record transaction', { error: err.message });
    }
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata || {};

        /**
         * Attribution, by metadata first and by Stripe customer second.
         *
         * `create-checkout-session` always sets the metadata, but it is not the
         * only way a subscription starts: a Stripe payment link, the Buy Button
         * and a subscription started from the dashboard all produce this event
         * with no metadata at all. That used to destructure to `undefined`, and
         * `where: { id: undefined }` throws in Sequelize — so the handler 500'd,
         * Stripe redelivered the event for three days, and a customer who had
         * genuinely paid stayed on the free plan throughout.
         *
         * The customer id belongs to us either way, so it is enough to find the
         * account.
         */
        const user = userId
          ? await User.findByPk(userId)
          : session.customer
            ? await User.findOne({ where: { stripeCustomerId: session.customer } })
            : null;

        if (!user) {
          // Nothing to retry: no later delivery of this event will carry an
          // attribution it does not have. Acknowledge so Stripe stops, and log
          // it as the operator's problem to reconcile.
          logger.error('checkout.session.completed could not be attributed to an account', {
            eventId: event.id, customer: session.customer, metadataUserId: userId,
          });
          break;
        }

        // Premium is the only tier sold, so an attributed checkout that names no
        // plan is a Premium one — and `customer.subscription.updated` follows
        // within moments, resolving the plan from the price that was actually
        // billed if it ever differs.
        const resolvedPlan = plan || 'premium';

        await User.update(
          { plan: resolvedPlan, stripeSubscriptionId: session.subscription, subscriptionStatus: 'active' },
          { where: { id: user.id } }
        );
        await recordTransaction({
          userId: user.id, type: 'checkout_completed', plan: resolvedPlan, status: 'succeeded',
          amount: session.amount_total, currency: session.currency,
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          const plan = planForPrice(sub.items.data[0]?.price?.id);
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
    // Answering 200 here would tell Stripe the event was applied and it would
    // never be redelivered — a customer who paid during a database blip would
    // stay on the free plan with no second chance. 5xx puts the event back into
    // Stripe's retry schedule; the handlers are idempotent (plan writes are
    // absolute, and `stripeEventId` is unique), so a replay is safe.
    logger.error('Stripe webhook handler failed', { eventId: event.id, type: event.type, error: err.message });
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  res.json({ received: true });
});

module.exports = router;
