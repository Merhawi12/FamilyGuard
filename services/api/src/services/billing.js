const Stripe = require('stripe');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { PLANS, PAID_PLAN_KEYS } = require('../config/plans');

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
 * Whether this deployment can actually complete a sale.
 *
 * A key is not enough, and treating it as enough is what put an Upgrade button
 * in front of customers on a deployment that answered 503 to every press. A
 * checkout needs a key *and* a price for something to sell; without the second
 * `create-checkout-session` refuses before it reaches Stripe.
 *
 * Read live rather than computed at import, for the same reason `priceIdFor`
 * is: a test that varies `env.stripe` must be able to move this, and the cost
 * is one property lookup.
 *
 * That applies to the key as much as to the price, which is why this asks
 * `env.stripe.secretKey` rather than `!!stripe`. The client above is fixed at
 * import — the two agree in any real deployment, since both come from the same
 * environment at boot, and only the env can be moved underneath a test.
 */
const canSell = () =>
  !!env.stripe.secretKey && PAID_PLAN_KEYS.some((key) => !!env.stripe[PLANS[key].priceEnv]);

/**
 * What is missing before a payment can be taken end to end, in words an
 * operator can act on. Empty means nothing is.
 *
 * The webhook secret is listed here but deliberately does **not** appear in
 * `canSell`. Its absence does not stop a customer paying — it stops the API
 * hearing about renewals, cancellations and failed cards afterwards, which is a
 * serious fault but not a reason to refuse the sale in front of you. The
 * customer's own return from Checkout now activates the subscription
 * (`/payments/checkout/confirm`), so the first payment lands either way; what a
 * missing secret costs is every event after it.
 */
const billingGaps = () => {
  const gaps = [];
  if (!env.stripe.secretKey) gaps.push('STRIPE_SECRET_KEY (no payment can be taken at all)');
  for (const key of PAID_PLAN_KEYS) {
    if (!env.stripe[PLANS[key].priceEnv]) {
      gaps.push(`STRIPE_${key.toUpperCase()}_PRICE_ID (the ${PLANS[key].label} cannot be sold)`);
    }
  }
  if (env.stripe.secretKey && !env.stripe.webhookSecret) {
    gaps.push('STRIPE_WEBHOOK_SECRET (renewals, cancellations and failed cards will never reach this API)');
  }
  return gaps.concat(env.stripe.problems || []);
};

/**
 * Said once, at boot, because every one of these is silent at runtime.
 *
 * Not fatal: `assertProductionConfig` refuses to start for a missing database or
 * signing key, and payments are deliberately not in that class — the trial and
 * the free tier work without Stripe, and taking the whole platform down because
 * a price ID is missing would be the more expensive failure. But nothing warned
 * either, so a deployment could take money and never upgrade the account with no
 * line anywhere saying why.
 */
const gaps = billingGaps();
if (gaps.length) {
  logger.error(`Stripe is not fully configured — ${gaps.length} problem(s)`, { problems: gaps });
}

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

module.exports = { stripe, cancelSubscription, canSell, billingGaps };
