const Stripe = require('stripe');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * The one Stripe client.
 *
 * It used to be constructed inside `routes/payments.js`, which was fine while
 * payments were the only thing that talked to Stripe. Closing an account also
 * has to — an account that disappears while its subscription keeps renewing goes
 * on charging a card belonging to someone who no longer has a login to stop it —
 * and a second `Stripe(...)` in another module would be a second client with its
 * own connection pool, and a second thing for the tests' manual mock to have to
 * know about.
 *
 * Null when no key is configured. Every caller checks: the deployment without
 * Stripe credentials is a real one (local development, the browser harness), and
 * it must not be a deployment where routes throw.
 */
const stripe = env.stripe.secretKey ? Stripe(env.stripe.secretKey) : null;

if (!stripe) logger.warn('STRIPE_SECRET_KEY not set — payment routes disabled');

/**
 * End a subscription now, and say whether it really ended.
 *
 * The return value is read rather than assumed. Deleting the account is the
 * irreversible half of closing it, and doing that while the subscription is
 * still live bills a customer who has no way left to notice, let alone cancel —
 * so the caller needs to be able to stop rather than press on.
 *
 * A subscription Stripe no longer has is success, not failure: `resource_missing`
 * means it is already gone, which is the state being asked for.
 */
const cancelSubscription = async (subscriptionId) => {
  if (!subscriptionId) return { ok: true, alreadyGone: true };
  if (!stripe) {
    // No credentials means nothing here created a subscription either.
    return { ok: true, alreadyGone: true };
  }

  try {
    await stripe.subscriptions.cancel(subscriptionId);
    return { ok: true, alreadyGone: false };
  } catch (err) {
    if (err?.code === 'resource_missing') return { ok: true, alreadyGone: true };
    logger.error('Could not cancel subscription', { subscriptionId, error: err.message });
    return { ok: false, error: err.message };
  }
};

module.exports = { stripe, cancelSubscription };
