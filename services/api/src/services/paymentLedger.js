const { env } = require('../config/env');
const { User, Transaction } = require('../models');
const { PLANS: PLAN_CATALOGUE, PAID_PLAN_KEYS, SUSPENDED_PLAN } = require('../config/plans');
const { stripe } = require('./billing');
// The receipt: bell, email and push. Never awaited by a handler — see `track`.
const { notifySubscriptionPayment } = require('../utils/billingNotice');
// The same news, told to the platform's own staff.
const { notifyStaffOfBillingEvent } = require('../utils/billingAdminNotice');
const { track } = require('../utils/background');
const logger = require('../utils/logger');

/**
 * What a payment does to an account, and how it is written down.
 *
 * This is the half of billing that must not have two implementations. Four
 * separate paths report the same money — Stripe's webhook, the customer's return
 * from Checkout (`/payments/checkout/confirm`), the first invoice of a
 * subscription, and the console's reconciliation against Stripe — and every time
 * one of them grew its own copy of "record the sale, grant the plan, tell
 * somebody", the copies disagreed. The most recent disagreement recorded two
 * `succeeded` rows for the first month of every subscription, so the console
 * double-counted the revenue that matters most.
 *
 * `routes/payments.js` is transport: it verifies signatures, decides what Stripe
 * is describing and answers with a status code. What that means for the database
 * lives here.
 */

// ── Reading a Stripe payload ─────────────────────────────────────────────────

/**
 * A Stripe reference as an id, whether or not the caller expanded it.
 *
 * Every `customer`, `invoice` and `subscription` field on an event payload is a
 * string id unless something asked for it to be expanded, in which case it is
 * the whole object. Both have to read the same here, because an `expand` added
 * upstream for an unrelated reason must not silently stop a lookup matching.
 */
const idOf = (ref) => {
  if (!ref) return null;
  return typeof ref === 'object' ? (ref.id || null) : ref;
};

/**
 * The Stripe price a plan sells at, read when it is needed rather than captured
 * at import.
 *
 * Nothing in production changes it after boot, so a snapshot was harmless there
 * and quietly awkward everywhere else: it is why the "plan with no price" branch
 * could not be reached without resetting the module graph, and the same reason
 * `billingAvailability.test.js` can vary `env.stripe` and this could not.
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
 * An unrecognised price still resolves to Premium, because a subscription exists
 * and refusing to name a plan would leave a paying customer with none — but it
 * is logged, since it means a Stripe price nobody configured here.
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
 * The price one invoice or subscription line was billed at, across both shapes
 * of the same field — `line.price` in the older payload,
 * `line.pricing.price_details.price` in the newer one.
 */
const priceOfLine = (line) => idOf(line?.price) || line?.pricing?.price_details?.price || null;

/**
 * The subscription an invoice was raised for.
 *
 * Stripe moved this from `invoice.subscription` to
 * `invoice.parent.subscription_details.subscription` in a later API version, and
 * this client deliberately pins no version — so the account's default decides
 * which shape arrives, and rolling it forward in the Stripe dashboard must not
 * quietly stop the handler recognising a renewal. Both are read.
 */
const subscriptionOf = (invoice) =>
  idOf(invoice?.subscription) || idOf(invoice?.parent?.subscription_details?.subscription);

/**
 * Which plan a paid invoice is for.
 *
 * Resolved from the price actually billed rather than from `user.plan`, because
 * the two disagree at exactly the moment that matters: `invoice.paid` for a new
 * subscription can arrive *before* `checkout.session.completed`, and the account
 * is still on `free` at that point. Recording that invoice as a payment for the
 * free plan is how a real sale ends up in the console under the wrong tier, and
 * missing from the paid-plan figures entirely.
 *
 * Falls back to the account's own plan for an invoice with no priced line — a
 * manually issued one, say — and to Premium for an account that is nominally on
 * none, since an invoice that was paid was not for the free tier.
 */
const planForInvoice = (invoice, user) => {
  const priceId = priceOfLine(invoice?.lines?.data?.[0]);
  if (priceId) return planForPrice(priceId);
  return user?.plan && user.plan !== 'free' ? user.plan : 'premium';
};

/**
 * Whether a retrieved session represents money actually taken.
 *
 * `no_payment_required` is included deliberately: a full-discount coupon or a
 * trial with no card due completes the session and owes nothing, and refusing to
 * grant the plan in that case would be refusing a sale the business made.
 */
const sessionIsPaid = (session) =>
  session?.status === 'complete'
  && ['paid', 'no_payment_required'].includes(session.payment_status);

/**
 * The account a Stripe object belongs to: by our own metadata first, by the
 * Stripe customer second.
 *
 * `create-checkout-session` always sets `metadata.userId`, but it is not the
 * only way a subscription starts: a Stripe payment link, the Buy Button and a
 * subscription started from the dashboard all arrive with no metadata at all.
 * The customer id belongs to us either way, so it is enough to find the account
 * — and a renewal invoice carries nothing else.
 *
 * The fall-through matters. A metadata id that no longer resolves — the account
 * was deleted and re-created, or the id came from another deployment's database
 * — used to end the search; now the customer is still tried, which is the
 * identifier Stripe itself considers authoritative.
 */
const accountFor = async ({ userId, customer } = {}) => {
  if (userId) {
    const byMetadata = await User.findByPk(userId);
    if (byMetadata) return byMetadata;
  }
  const customerId = idOf(customer);
  if (customerId) return User.findOne({ where: { stripeCustomerId: customerId } });
  return null;
};

// ── Writing it down ──────────────────────────────────────────────────────────

/**
 * Records a transaction unless one with this key already exists.
 *
 * The key is the caller's, not the event's, because one payment is reported
 * three times: by `checkout.session.completed`, by `invoice.paid` with
 * `billing_reason: 'subscription_create'`, and by the customer coming back from
 * Checkout. All three name it `invoice:<invoice id>` — see `paymentKeyFor` — so
 * the unique constraint on `stripeEventId` makes the second and third no-ops
 * instead of duplicate rows, which is what used to double-count the first month
 * of every subscription on the console's Billing screen.
 *
 * The return value says whether *this* call was the one that recorded it, and
 * that is what decides who tells the customer. Every path reports the same
 * payment and every one of them would otherwise send a receipt, so the customer
 * would be emailed twice for one charge — and the paths are genuinely
 * concurrent, since Stripe's webhook and the browser's return race each other.
 * Letting the unique constraint pick the winner is the only version of this that
 * is safe under that race: whoever inserts the row sends, and the loser learns
 * it lost.
 */
const recordTransaction = async (data, stripeEventId) => {
  try {
    await Transaction.create({ ...data, stripeEventId });
    return true;
  } catch (err) {
    // A duplicate surfaces as a SequelizeUniqueConstraintError whose message is
    // just "Validation error" — check the type, not the text, so real failures
    // still get logged.
    if (err.name !== 'SequelizeUniqueConstraintError') {
      logger.error('Failed to record transaction', { error: err.message });
    }
    return false;
  }
};

/**
 * The key one payment is recorded under — the invoice it was taken against.
 *
 * **This is what stops a new subscription being recorded twice.** Stripe reports
 * the first charge of a subscription through two events:
 * `checkout.session.completed` and `invoice.paid` with `billing_reason:
 * 'subscription_create'`. They describe the same money. Keyed on the session and
 * on the event id respectively, they produced two `succeeded` rows for one
 * payment — so the console's payment log listed every new subscription twice,
 * once as "New subscription" and once as "Renewal", and every revenue figure
 * derived from those rows (MRR against last month, the revenue trend, the billed
 * totals) counted the first month of every subscription at double its value.
 *
 * The invoice is the one identifier both events carry, so it is the identity of
 * the payment. Whichever event arrives first inserts the row; the other collapses
 * onto it through the unique constraint on `stripeEventId`, exactly as a
 * redelivery does.
 *
 * The fallbacks are for the sessions that have no invoice, which are real:
 * `no_payment_required` — a hundred-percent coupon, a trial with no card due —
 * completes and raises nothing to bill. Those key on the session, and a session
 * with no id of its own keys on the caller's own last resort (the webhook passes
 * its event id). `checkout:undefined` would be a landmine rather than a
 * safeguard: every id-less completion a deployment ever saw would collapse onto
 * one row and only the first sale would be recorded.
 */
const paymentKeyFor = (session, fallbackKey) => {
  const invoiceId = idOf(session?.invoice);
  if (invoiceId) return `invoice:${invoiceId}`;
  if (session?.id) return `checkout:${session.id}`;
  return fallbackKey;
};

/**
 * The invoice behind a completed Checkout session.
 *
 * The first payment's receipt used to carry no invoice at all. Only the monthly
 * `invoice.paid` handler passed a `receiptUrl`, because that event *is* an
 * invoice — a Checkout session only carries its id, so the activation email
 * offered nothing to download for the one payment a customer is most likely to
 * want a record of. The renewals were documented and the purchase was not.
 *
 * Three shapes have to be tolerated, and the difference is not cosmetic:
 *
 *   - a **string** id, which is what both callers actually see (the webhook's
 *     event payload and `sessions.retrieve` without an `expand`);
 *   - an **object**, if a caller ever expands it — returned as-is rather than
 *     re-fetched, so adding `expand` upstream is a saving and not a bug;
 *   - **null**, which is legitimate. A `no_payment_required` session — a
 *     hundred-percent coupon, a trial with no card due — completes and owes
 *     nothing, so there is no invoice to link and the email is written to read
 *     correctly without one.
 *
 * Never throws. This runs off the back of a settled payment, so a Stripe blip
 * here must cost the receipt its download link and nothing else — least of all a
 * 5xx from the webhook, which would put the event back in Stripe's retry
 * schedule after the transaction row already exists, and the receipt would then
 * never be sent at all.
 */
const invoiceForSession = async (session) => {
  const ref = session?.invoice;
  if (!ref) return null;
  if (typeof ref === 'object') return ref;
  if (!stripe) return null;

  try {
    return await stripe.invoices.retrieve(ref);
  } catch (err) {
    logger.error('Could not retrieve the invoice for a completed checkout', {
      invoice: ref, error: err.message,
    });
    return null;
  }
};

/**
 * Everything a completed Checkout session does to an account, in one place.
 *
 * Two paths reach it — the webhook, and the customer returning with a session id
 * — and they must not be able to disagree about what "paid" means. The write is
 * absolute rather than incremental (`plan` set, not bumped), so running it twice
 * leaves the same account state; only the transaction row needs guarding, and it
 * is keyed on the invoice so every path collapses onto one.
 *
 * Premium is the only tier sold, so a session that names no plan is a Premium
 * one. `customer.subscription.updated` follows within moments and resolves the
 * plan from the price actually billed if it ever differs.
 *
 * `fallbackKey` is what the sale is recorded under when the session names
 * neither an invoice nor an id of its own. The webhook passes its event id,
 * which is unique per delivery.
 */
const applyCheckoutCompletion = async (user, session, { fallbackKey, io } = {}) => {
  const plan = session.metadata?.plan || 'premium';

  await User.update(
    { plan, stripeSubscriptionId: idOf(session.subscription), subscriptionStatus: 'active' },
    { where: { id: user.id } }
  );

  const reference = paymentKeyFor(session, fallbackKey);
  const firstReport = await recordTransaction({
    userId: user.id,
    type: 'checkout_completed',
    plan,
    status: 'succeeded',
    amount: session.amount_total,
    currency: session.currency,
  }, reference);

  /**
   * Telling the customer, exactly once.
   *
   * Gated on the transaction insert rather than on which path we are: this
   * function runs for the webhook *and* for the customer's return from Checkout,
   * they race, and whichever loses must not send a second receipt for the same
   * charge. See `recordTransaction`.
   *
   * Not awaited. A payment is settled by the time this runs, and neither Stripe
   * nor a customer watching the plan screen should wait on an SMTP relay —
   * worse, a mail failure inside the webhook handler would answer 5xx and put
   * the event back in Stripe's retry schedule, where the transaction row now
   * exists and the receipt would never be sent again. `track` keeps a handle on
   * it so a redeploy cannot drop it mid-flight and the tests can await it.
   */
  if (firstReport) {
    /**
     * The invoice lookup lives inside the tracked work, not before it.
     *
     * It is one Stripe round trip and it is only worth making for the caller
     * that actually sends the receipt: the webhook and the customer's return
     * genuinely race, `firstReport` is how the loser is told to stay quiet, and
     * fetching the invoice before that check would spend the call on both. It
     * also keeps the round trip off the critical path — the webhook has to
     * answer Stripe promptly, and the customer is watching the plan screen.
     */
    track((async () => {
      const invoice = await invoiceForSession(session);
      return notifySubscriptionPayment({
        io,
        user,
        kind: 'activated',
        plan,
        amount: session.amount_total,
        currency: session.currency,
        // The line item's period is the subscription's own, and the invoice's is
        // the billing window; they agree for a straightforward monthly plan.
        // Either answers the question the customer actually has — "when does
        // this happen again" — which the activation email could not say before.
        periodEnd: invoice?.lines?.data?.[0]?.period?.end ?? invoice?.period_end,
        receiptUrl: invoice?.hosted_invoice_url || null,
      });
    })());

    /**
     * And the platform's own staff, on the same gate.
     *
     * A sale used to reach the console only as a row somebody had to think to go
     * and look for. This puts it in the audit stream — where it is filterable,
     * and where the Overview counts it — and in the bell of every account that
     * holds `manage_billing`.
     *
     * Sharing `firstReport` with the customer's receipt is what keeps the two
     * counts honest: one payment, one entry, whichever path got here first.
     */
    track(notifyStaffOfBillingEvent({
      io, user, kind: 'activated', plan,
      amount: session.amount_total, currency: session.currency, reference,
    }));
  }

  return { plan, recorded: firstReport, reference };
};

/**
 * Everything a paid invoice does to an account.
 *
 * Reached from `invoice.paid` and from the console's reconciliation, which must
 * not be able to record the same payment differently from the webhook — that is
 * the whole point of a reconciliation.
 *
 * @param {object}   args
 * @param {object}   args.invoice   Stripe invoice, paid.
 * @param {object}   args.user      The account it belongs to.
 * @param {object=}  args.io        Socket.io server, when the caller has one.
 * @param {string=}  args.fallbackKey  Key for an invoice with no id of its own.
 * @param {boolean=} args.notifyCustomer  False for a backfill — see below.
 */
const applyInvoicePayment = async ({ invoice, user, io, fallbackKey, notifyCustomer = true }) => {
  /**
   * The first invoice of a subscription is the same money as the Checkout
   * session that produced it. Both are keyed on the invoice, so whichever
   * arrives first records the sale and the other collapses onto it — see
   * `paymentKeyFor`.
   */
  const startsSubscription = invoice.billing_reason === 'subscription_create';
  const plan = planForInvoice(invoice, user);
  const subscriptionId = subscriptionOf(invoice);

  /**
   * A paid invoice means the subscription is current, whatever the account
   * looked like a moment ago.
   *
   * Stripe's retry landing after a failed card left the account on `past_due`
   * until an unrelated `customer.subscription.updated` happened to arrive — and
   * with dunning set to "mark unpaid" or "pause", one that says `active` may
   * never come. The console showed a customer as behind on payments while their
   * money was in the bank.
   *
   * A suspended account is the one thing this does not lift: that is a staff
   * decision about the account, not a statement about its card, and a renewal
   * must not quietly reverse it.
   */
  await user.update({
    subscriptionStatus: 'active',
    ...(startsSubscription && user.plan !== SUSPENDED_PLAN ? { plan } : {}),
    ...(startsSubscription && subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
  });

  const reference = invoice.id ? `invoice:${invoice.id}` : fallbackKey;
  const kind = startsSubscription ? 'activated' : 'renewed';
  const recorded = await recordTransaction({
    userId: user.id,
    // The console reads `checkout_completed` as "New subscription" and counts it
    // as a subscription won; a first invoice is exactly that, and labelling it a
    // renewal would understate every month's new business by however many
    // customers Stripe reported this way first.
    type: startsSubscription ? 'checkout_completed' : 'invoice_paid',
    plan,
    status: 'succeeded',
    amount: invoice.amount_paid,
    currency: invoice.currency,
  }, reference);

  if (recorded) {
    /**
     * The receipt — the half of this that a customer notices most.
     *
     * Premium bills every month and nothing told anybody. A recurring charge
     * that arrives silently is the one people find on a statement and resent,
     * and it is also how a subscription somebody meant to cancel keeps taking
     * money unremarked.
     *
     * The gate is the transaction row alone. `subscription_create` used to be
     * skipped outright, on the assumption that `checkout.session.completed` had
     * already congratulated the customer — but the two events race, and when
     * this one won the race the customer was told nothing at all. Sharing the
     * key means whichever arrives first sends, and the reason only decides the
     * wording: a first invoice reads as an activation, everything else — a
     * renewal, a proration, a retried charge, a manually issued invoice — as a
     * payment received.
     *
     * `notifyCustomer` is false only for the console's reconciliation. Backfills
     * are for payments that are already weeks old; emailing somebody a receipt
     * for a charge they saw on a statement in July, because an operator pressed
     * Sync in September, is noise pretending to be service. Staff are told
     * either way — the whole point of the backfill is that they did not know.
     */
    if (notifyCustomer) {
      track(notifySubscriptionPayment({
        io,
        user,
        kind,
        plan,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        // The line item's period is the subscription's own; `period_end` on the
        // invoice is the billing window and matches it for a straightforward
        // monthly plan. Either is the date the customer is asking about — "when
        // does this happen again".
        periodEnd: invoice.lines?.data?.[0]?.period?.end ?? invoice.period_end,
        receiptUrl: invoice.hosted_invoice_url || null,
      }));
    }

    track(notifyStaffOfBillingEvent({
      io, user, kind, plan, amount: invoice.amount_paid, currency: invoice.currency, reference,
    }));
  }

  return { plan, recorded, reference, kind };
};

module.exports = {
  idOf,
  priceIdFor,
  planForPrice,
  priceOfLine,
  subscriptionOf,
  planForInvoice,
  sessionIsPaid,
  accountFor,
  recordTransaction,
  paymentKeyFor,
  invoiceForSession,
  applyCheckoutCompletion,
  applyInvoicePayment,
};
