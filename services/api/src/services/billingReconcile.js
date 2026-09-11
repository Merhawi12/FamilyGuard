const { stripe } = require('./billing');
const { accountFor, applyInvoicePayment, idOf } = require('./paymentLedger');
const logger = require('../utils/logger');

/**
 * Catching the console up with Stripe.
 *
 * The webhook is how a payment is *supposed* to reach this database, and when it
 * works nothing here is needed. But it is a single point of failure that fails
 * silently and invisibly: with `STRIPE_WEBHOOK_SECRET` unset or stale, every
 * delivery is rejected 400 at the signature check, Stripe retries for three days
 * and gives up, and the only symptom is that the console's Billing screen is
 * missing payments nobody knows to look for. That is the shape of the complaint
 * this exists for — "the payment completed and it is not in the dashboard".
 *
 * The endpoint is deliberately manual rather than a schedule. An operator who
 * has just fixed the webhook secret, or who is looking at a customer insisting
 * they paid, presses it and gets an answer about *this* deployment. A background
 * job doing the same thing quietly would make the webhook's failure permanently
 * invisible, which is the condition being fixed and not a thing to automate away.
 *
 * **It cannot double-record.** Every invoice goes through `applyInvoicePayment`,
 * the same function the webhook uses, keyed on `invoice:<id>` — so a payment
 * already in the table is recognised and skipped, and running this twice in a
 * row changes nothing the second time. That is also why it is safe to run over a
 * window that mostly overlaps what is already known.
 */

const DAY_SECONDS = 24 * 60 * 60;

/** Stripe's maximum page, and how many of them one press is allowed to walk. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * How far back a sync may look.
 *
 * A month by default, because that is one billing cycle and covers the case this
 * was written for — the webhook broke, and it has been broken for a while. The
 * ceiling is a year: beyond that the invoices predate anything the Billing
 * screen's own charts can show, and the walk is bounded at
 * `MAX_PAGES × PAGE_SIZE` invoices in any case.
 */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

const clampDays = (value) => {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_DAYS;
  return Math.min(Math.round(days), MAX_DAYS);
};

/**
 * Records every paid Stripe invoice in the window that this database does not
 * already have.
 *
 * @param {object}  args
 * @param {number=} args.days  How far back to look; clamped to [1, 366].
 * @param {object=} args.io    Socket.io server, for the staff notifications.
 * @returns {Promise<object>}  A report the console renders verbatim.
 */
const reconcileStripePayments = async ({ days, io } = {}) => {
  const window = clampDays(days);

  if (!stripe) {
    // Not an error the caller did anything about — this deployment simply has no
    // Stripe credentials, and saying so is more use than an empty report that
    // reads as "nothing was missing".
    return {
      available: false,
      reason: 'Stripe is not configured on this deployment, so there is nothing to reconcile against.',
      days: window,
      scanned: 0,
      recorded: 0,
      alreadyRecorded: 0,
      unattributed: 0,
    };
  }

  const createdAfter = Math.floor(Date.now() / 1000) - window * DAY_SECONDS;

  let scanned = 0;
  let recorded = 0;
  let alreadyRecorded = 0;
  /** Invoices whose Stripe customer matches no account here — money we cannot credit. */
  const unattributed = [];
  let truncated = false;
  let startingAfter;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    /* eslint-disable no-await-in-loop -- pagination is sequential by construction:
       each page's cursor is the last id of the one before it. */
    const batch = await stripe.invoices.list({
      status: 'paid',
      created: { gte: createdAfter },
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    const invoices = batch?.data || [];
    if (invoices.length === 0) break;

    for (const invoice of invoices) {
      scanned += 1;

      const user = await accountFor({ customer: invoice.customer });
      if (!user) {
        /**
         * A paid invoice belonging to no account here.
         *
         * Reported rather than skipped silently: it is real money Stripe took
         * that this platform cannot attribute, and the only way it gets fixed is
         * somebody looking at the invoice in Stripe. The commonest cause is
         * benign — the key points at a Stripe account this database was never
         * the backend for — and that is worth knowing too, since it means the
         * whole sync is measuring the wrong account.
         */
        unattributed.push({ invoice: invoice.id, customer: idOf(invoice.customer) });
        continue;
      }

      // Not awaited in parallel: each one writes to the same two tables, and a
      // reconciliation that hammers the database to finish half a second sooner
      // is the wrong trade on a request an operator pressed once.
      const result = await applyInvoicePayment({
        invoice,
        user,
        io,
        fallbackKey: `stripe-sync:${invoice.id || `${user.id}:${invoice.created}`}`,
        /**
         * The customer is not emailed for a backfill.
         *
         * These are payments that are already days or weeks old — the customer
         * saw the charge on their statement long ago. A receipt arriving now,
         * because an operator pressed Sync, is noise pretending to be service,
         * and a sync over a month of renewals would send a burst of them at
         * once. Staff *are* told, which is the entire point: they are the ones
         * who did not know.
         */
        notifyCustomer: false,
      });

      if (result.recorded) recorded += 1;
      else alreadyRecorded += 1;
    }

    if (!batch?.has_more) break;
    startingAfter = invoices[invoices.length - 1].id;
    // The last page of the allowance still had more behind it, so the report has
    // to say the window was not fully covered rather than implying it was.
    if (page === MAX_PAGES - 1) truncated = true;
    /* eslint-enable no-await-in-loop */
  }

  logger.info('Reconciled payments against Stripe', {
    days: window, scanned, recorded, alreadyRecorded, unattributed: unattributed.length,
  });

  return {
    available: true,
    days: window,
    scanned,
    /** Payments that were missing from this database until now. */
    recorded,
    /** Payments the webhook had already delivered. */
    alreadyRecorded,
    unattributed: unattributed.length,
    // Capped: the report is rendered in a dialog, and a key that is pointed at
    // the wrong Stripe account would otherwise return a thousand of these.
    unattributedInvoices: unattributed.slice(0, 10),
    truncated,
  };
};

module.exports = { reconcileStripePayments, DEFAULT_DAYS, MAX_DAYS };
