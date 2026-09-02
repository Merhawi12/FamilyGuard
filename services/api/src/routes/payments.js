const express = require('express');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const router = express.Router();
const { User, Transaction } = require('../models');
const { authenticate } = require('../middleware/auth');
const { PLANS: PLAN_CATALOGUE, PAID_PLAN_KEYS } = require('../config/plans');
// The confirm route hands the refreshed account straight back, so the plan
// screen does not have to make a second call to learn what it just bought.
const { serializeUser } = require('../utils/serializers');
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
/**
 * The split is "will retrying help", not "which error is it".
 *
 * Stripe names four failures that mean the request itself was wrong, and every
 * one of them will be wrong again in ten seconds: the key is not a key
 * (`Authentication`), the key is not allowed to do this (`Permission`), the
 * parameters name something that does not exist (`InvalidRequest`), or the same
 * idempotency key was reused for a different body. All four are a deployment's
 * configuration, and none of them is worth a "please try again".
 *
 * `Permission` is the one this was written for. It is what a *restricted* key
 * returns when it is missing a scope — and a restricted key is the recommended
 * way to run this service, so the recommended setup had a failure mode reported
 * as "the payment provider could not be reached", under a button offering to try
 * it again. That sentence is wrong twice: Stripe was reached, and it answered.
 *
 * `InvalidRequest` used to be matched by message text — "No such price", "No
 * such plan", "not recurring" — which caught the three examples somebody had in
 * front of them and let every other one through. Every parameter these two
 * endpoints send is chosen by this service, not by the customer, so an invalid
 * one is ours by construction and the text does not need reading.
 */
const RETRY_WILL_NOT_HELP = new Set([
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeInvalidRequestError',
  'StripeIdempotencyError',
]);

/**
 * Records a transaction unless one with this key already exists.
 *
 * The key is the caller's, not the event's, because one payment can now be
 * reported twice: by `checkout.session.completed` and by the customer coming
 * back from Checkout. Both name the completion `checkout:<session id>`, so the
 * unique constraint on `stripeEventId` makes the second a no-op instead of a
 * duplicate row — which would otherwise double-count the sale on the console's
 * Billing screen.
 */
const recordTransaction = async (data, stripeEventId) => {
  try {
    await Transaction.create({ ...data, stripeEventId });
  } catch (err) {
    // A duplicate surfaces as a SequelizeUniqueConstraintError whose message is
    // just "Validation error" — check the type, not the text, so real failures
    // still get logged.
    if (err.name !== 'SequelizeUniqueConstraintError') {
      logger.error('Failed to record transaction', { error: err.message });
    }
  }
};

/**
 * Everything a completed Checkout session does to an account, in one place.
 *
 * Two paths reach it — the webhook, and the customer returning with a session
 * id — and they must not be able to disagree about what "paid" means. The write
 * is absolute rather than incremental (`plan` set, not bumped), so running it
 * twice leaves the same account state; only the transaction row needs guarding,
 * and it is keyed on the session so both paths collapse onto one.
 *
 * Premium is the only tier sold, so a session that names no plan is a Premium
 * one. `customer.subscription.updated` follows within moments and resolves the
 * plan from the price actually billed if it ever differs.
 *
 * `fallbackKey` is what the sale is recorded under when the session carries no
 * id of its own. Stripe always sends one in practice, but keying on
 * `checkout:undefined` would be a landmine rather than a safeguard: every
 * id-less completion the deployment ever saw would collapse onto a single row
 * and only the first sale would be recorded. The webhook passes its event id,
 * which is unique per delivery and is exactly what this was keyed on before the
 * confirm route existed.
 */
const applyCheckoutCompletion = async (user, session, fallbackKey) => {
  const plan = session.metadata?.plan || 'premium';

  await User.update(
    { plan, stripeSubscriptionId: session.subscription || null, subscriptionStatus: 'active' },
    { where: { id: user.id } }
  );

  await recordTransaction({
    userId: user.id,
    type: 'checkout_completed',
    plan,
    status: 'succeeded',
    amount: session.amount_total,
    currency: session.currency,
  }, session.id ? `checkout:${session.id}` : fallbackKey);

  return plan;
};

/**
 * Whether a retrieved session represents money actually taken.
 *
 * `no_payment_required` is included deliberately: a full-discount coupon or a
 * trial with no card due completes the session and owes nothing, and refusing
 * to grant the plan in that case would be refusing a sale the business made.
 */
const sessionIsPaid = (session) =>
  session?.status === 'complete'
  && ['paid', 'no_payment_required'].includes(session.payment_status);

/**
 * A stored Stripe customer that Stripe does not have.
 *
 * `users.stripeCustomerId` is a foreign key into someone else's database, and it
 * can stop resolving without anything here changing: the deployment's key is
 * rolled to a different Stripe account, an account is moved between test and
 * live mode, or the customer is deleted from the dashboard. The id stays on the
 * row and every later call carries it.
 *
 * Production hit exactly this — `No such customer: 'cus_V9bGIsYwyG7Y4a'`,
 * `resource_missing`, twice within seven minutes — and the shape of the failure
 * is what made it worth a fix rather than a support ticket. It is a
 * `StripeInvalidRequestError`, so `RETRY_WILL_NOT_HELP` correctly classified it
 * as a configuration fault and the plan screen withdrew the Upgrade button. That
 * verdict was right about "retrying will not help" and wrong about whose problem
 * it is: nothing was misconfigured, and no amount of fixing the deployment would
 * have helped, because the dead id was on one user's row. That account could
 * never subscribe again, by construction, and the button vanishing told them
 * their deployment could not take payments.
 */
const customerIsMissing = (err) => err?.code === 'resource_missing'
  && (err?.param === 'customer' || /no such customer/i.test(err?.message || ''));

/**
 * The Stripe customer for this account, creating one if there is not a usable
 * one already.
 *
 * `email` is omitted rather than sent as null for a phone-only account: Stripe
 * treats an explicit null as "clear it", and a customer with no address simply
 * has no receipt destination until one is added.
 */
const ensureCustomer = async (user) => {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    name: user.name,
    ...(user.email ? { email: user.email } : {}),
  });
  await user.update({ stripeCustomerId: customer.id });
  return customer.id;
};

/**
 * Runs a Stripe call that takes a customer id, and re-creates the customer once
 * if Stripe says the stored one does not exist.
 *
 * One retry, not a loop: the second failure is a real one, and a customer this
 * service has just created and been handed back cannot also be missing. Forget
 * before create, so the row never keeps an id that has been proven dead even if
 * the creation itself then fails.
 */
const withLiveCustomer = async (user, call) => {
  const customerId = await ensureCustomer(user);
  try {
    return await call(customerId);
  } catch (err) {
    if (!customerIsMissing(err)) throw err;

    logger.warn('Stored Stripe customer no longer exists — creating a replacement', {
      userId: user.id, staleCustomerId: customerId,
    });
    await user.update({ stripeCustomerId: null });
    return call(await ensureCustomer(user));
  }
};

const sendStripeFailure = (res, err, context) => {
  const configFault = RETRY_WILL_NOT_HELP.has(err?.type);

  logger.error('Stripe request failed', { ...context, type: err?.type, code: err?.code, error: err?.message });

  // Stripe's wording names the exact key, price or scope at fault, which is what
  // makes it fixable — but it describes our infrastructure, so a customer in
  // production never sees it. Locally it is the whole point, and that is as true
  // of a connection failure as of a configuration one: "could not be reached"
  // with nothing after it is not a thing anybody can act on.
  const detail = env.isProduction ? {} : { detail: err.message, type: err?.type };

  if (configFault) {
    return res.status(503).json({
      error: 'Payments are not set up correctly on this deployment. Please contact support.',
      configurationError: true,
      ...detail,
    });
  }

  return res.status(502).json({
    error: 'The payment provider could not be reached. Please try again.',
    ...detail,
  });
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

    // Reuses the stored customer, and replaces it if Stripe no longer has it —
    // see `withLiveCustomer`. A dead id used to make this account permanently
    // unable to subscribe.
    const session = await withLiveCustomer(user, (customerId) => stripe.checkout.sessions.create({
      /**
       * Ours, and not negotiable.
       *
       * `customer` ties the subscription to the Stripe customer this service
       * stores, and `metadata.userId` is how `checkout.session.completed`
       * attributes a payment to an account. Drop either and a customer whose
       * card was charged stays on the free plan — see the attribution block in
       * the webhook handler, which exists because that has happened.
       */
      customer: customerId,
      metadata: { userId: user.id, plan },
      mode: 'subscription',
      line_items: [{ price: priceIdFor(plan), quantity: 1 }],
      /**
       * The session id travels back with the customer, and that is what makes
       * the upgrade survive a webhook that never arrives.
       *
       * `?payment=success` alone was a claim the browser made about itself: the
       * plan screen printed "your plan has been upgraded" on the strength of a
       * query string, while the only thing that actually upgrades an account is
       * `checkout.session.completed`. With STRIPE_WEBHOOK_SECRET unset — which
       * nothing refuses to start over and nothing warns about — every one of
       * those deliveries fails signature verification, so the customer was
       * charged, congratulated, and left on Free.
       *
       * `{CHECKOUT_SESSION_ID}` is substituted by Stripe. `/checkout/confirm`
       * exchanges it for the same plan write the webhook performs, keyed on the
       * same id so whichever path arrives first is the only one that counts.
       */
      success_url: `${env.clientUrl}/dashboard/settings?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${env.clientUrl}/dashboard/settings?payment=cancelled`,

      /**
       * Configured in Stripe's Checkout Studio; changed there, not here.
       *
       * `payment_method_collection` is subscription-only and this session is
       * always a subscription — Premium is the one tier sold.
       *
       * `payment_method_types: ['card']` was removed rather than kept: pinning
       * it here overrides the payment methods enabled on the Stripe account, so
       * turning one on in the dashboard would have done nothing. Unset is what
       * lets the dashboard decide, which is where the rest of this block is
       * decided too.
       *
       * ## Four of the Studio's parameters are deliberately absent
       *
       * `ui_mode: 'hosted_page'`, `submit_type`, `integration_identifier` and
       * `origin_context` were applied and then removed, because checkout began
       * answering "Payments are not set up correctly on this deployment" the
       * moment they arrived.
       *
       * They are the four that depend on how new the *account's* default API
       * version is — this client pins no version, deliberately — and Stripe
       * refuses a parameter it does not recognise outright rather than ignoring
       * it. `submit_type` carries a second constraint: it has historically been
       * accepted only with `mode: 'payment'`, and every session here is a
       * subscription. Losing them costs nothing visible: `hosted` is what
       * `ui_mode` defaults to, `submit_type: 'auto'` is the default wording, and
       * the other two are labels Stripe attributes the integration by.
       *
       * `origin_context: 'mobile_app'` was also simply untrue. This session is
       * created for a parent on the web dashboard; the Android build is the same
       * page in a WebView, and neither is a native mobile checkout.
       *
       * To put them back: pin an API version on the client that accepts them
       * (`Stripe(key, { apiVersion: '…' })` in services/billing) and re-add them
       * one at a time. `payments.test.js` pins what is sent either way.
       */
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      payment_method_collection: 'always',
    }));

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
    // Still a 400 rather than a created customer: the portal manages an existing
    // subscription, and an account that has never had one has nothing to show
    // there. `withLiveCustomer` would happily mint a customer for it, which is
    // the right thing before a checkout and the wrong thing here.
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'No active subscription' });

    // A stale customer id breaks this the same way it broke checkout, and the
    // customer meets it at a worse moment: cancelling. Replacing it is enough to
    // open the portal, which then correctly shows no subscription rather than
    // an error page.
    const session = await withLiveCustomer(user, (customerId) => stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.clientUrl}/dashboard/settings`,
    }));

    res.json({ url: session.url });
  } catch (err) {
    return sendStripeFailure(res, err, { where: 'billing_portal' });
  }
  return undefined;
});

/**
 * POST /api/payments/checkout/confirm — the customer is back from Stripe.
 *
 * The second of two ways an account becomes Premium, and the one that does not
 * depend on a webhook being configured. `checkout.session.completed` remains the
 * authority for everything that happens away from a browser — a renewal, a card
 * that fails next month, a subscription cancelled from the portal — but it is
 * the wrong single point of failure for the one moment the customer is watching:
 * with `STRIPE_WEBHOOK_SECRET` unset, every delivery fails signature
 * verification, and nothing in the product noticed. The account was charged and
 * stayed on Free while the screen said otherwise.
 *
 * Stripe is the source of truth here, not the browser. The session id in the URL
 * proves nothing on its own — anyone can put a string there — so it is exchanged
 * with Stripe for the real session, and the plan is granted only if Stripe says
 * that session is complete and paid.
 *
 * Ownership is checked twice over. `metadata.userId` is what this service wrote
 * when it created the session; `customer` is the Stripe customer stored against
 * the account. Either identifies the owner, and a session matching neither is a
 * 403 — without that check a customer who guessed or was shown somebody else's
 * session id could upgrade their own account with another family's payment.
 *
 * Idempotent by construction: the plan write is absolute and the transaction is
 * keyed on the session, so a refresh, a retry and a later webhook delivery all
 * converge on one upgraded account and one recorded sale.
 */
router.post('/checkout/confirm', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });

  const { sessionId } = req.body || {};
  // Stripe's own prefix. Checked before spending a round trip on a value that
  // cannot be a session, and so the error names the real problem.
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return res.status(400).json({ error: 'A Checkout session id is required' });
  }

  try {
    const [user, session] = await Promise.all([
      User.findByPk(req.user.id),
      stripe.checkout.sessions.retrieve(sessionId),
    ]);

    const ownedByMetadata = session.metadata?.userId === user.id;
    const ownedByCustomer = !!user.stripeCustomerId && session.customer === user.stripeCustomerId;
    if (!ownedByMetadata && !ownedByCustomer) {
      logger.error('Checkout confirmation attempted for a session belonging to another account', {
        userId: user.id, sessionId,
      });
      return res.status(403).json({ error: 'That payment does not belong to this account' });
    }

    if (!sessionIsPaid(session)) {
      /**
       * Not an error, and not a grant either.
       *
       * A bank redirect or a delayed payment method can leave a session
       * `complete` with payment still `unpaid`, and the customer arrives here
       * before the money does. `checkout.session.completed` will finish the job
       * when it settles, so the honest answer is that it is pending — which the
       * plan screen can say, rather than either congratulating them or
       * announcing a failure that has not happened.
       */
      return res.json({
        activated: false,
        pending: true,
        status: session.status,
        paymentStatus: session.payment_status,
      });
    }

    const plan = await applyCheckoutCompletion(user, session);
    await user.reload();

    logger.info('Checkout confirmed on return from Stripe', { userId: user.id, plan, sessionId });
    return res.json({ activated: true, plan, user: serializeUser(user) });
  } catch (err) {
    return sendStripeFailure(res, err, { where: 'checkout_confirm' });
  }
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

  // Everything except the checkout completion is keyed on the event, which is
  // what makes a redelivery a no-op. The completion is keyed on its session
  // instead — see `applyCheckoutCompletion` — because the customer's own return
  // from Stripe reports the same sale and the two must collapse onto one row.
  const record = (data) => recordTransaction(data, event.id);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Only the attribution is read here now; the plan is resolved inside
        // `applyCheckoutCompletion`, which both this and the customer's own
        // return from Checkout go through.
        const { userId } = session.metadata || {};

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

        // The same write the customer's return from Checkout performs, from the
        // same function, so the two paths cannot come to different conclusions
        // about what a completed session grants. The event id is the key of last
        // resort, for a completion that names no session.
        await applyCheckoutCompletion(user, session, event.id);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          const plan = planForPrice(sub.items.data[0]?.price?.id);
          await user.update({ subscriptionStatus: sub.status, plan });
          await record({ userId: user.id, type: 'subscription_updated', plan, status: sub.status });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: sub.customer } });
        if (user) {
          await user.update({ plan: 'free', stripeSubscriptionId: null, subscriptionStatus: 'cancelled' });
          await record({ userId: user.id, type: 'subscription_cancelled', plan: 'free', status: 'cancelled' });
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const user = await User.findOne({ where: { stripeCustomerId: invoice.customer } });
        if (user) {
          await record({
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
          await record({
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
