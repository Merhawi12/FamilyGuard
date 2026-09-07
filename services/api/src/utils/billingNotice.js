const { Notification } = require('../models');
const { sendSubscriptionActivatedEmail, sendSubscriptionRenewedEmail } = require('./email');
// Called through the module rather than destructured so the send stays
// interceptable — the tests assert on what a payment actually dispatches.
const pushService = require('./pushService');
const { planLabel } = require('../config/plans');
const logger = require('./logger');

/**
 * Telling a customer their money arrived.
 *
 * A payment used to be completely silent. The account was upgraded, the plan
 * screen said "Payment successful" on the page the customer was already
 * looking at, and then nothing: no receipt in the inbox, nothing in the bell,
 * no push. Close the tab and the only evidence a subscription existed was a line
 * on a card statement a month later — and the monthly renewals after it were
 * silent too, which is the version of this that matters most. A recurring charge
 * nobody is told about is the one people find by accident and resent.
 *
 * Three channels, because they answer different questions and fail
 * independently:
 *
 *   email   the receipt, and the only one that survives outside the product.
 *           It is also the channel this deployment is most likely to be unable
 *           to send (see docs/DEPLOYMENT.md §1.7) — which is exactly why it is
 *           not the only one.
 *   in-app  a `Notification` row, so the bell shows it whenever the parent next
 *           opens the dashboard, and the socket emit puts it there immediately
 *           if they are looking now.
 *   push    for the renewal months, when nobody is watching a screen.
 *
 * Every channel is attempted independently and none of them can fail the
 * payment: this is called from the checkout completion and the webhook, and a
 * mail relay being down must never turn a successful payment into a 500 that
 * Stripe then retries.
 *
 * Not preference-gated — see the block above `sendSubscriptionActivatedEmail`.
 */

/** Where tapping the notification should take the parent. */
const BILLING_DESTINATION = '/dashboard/settings?section=plan';

/**
 * Stripe's minor units as something a person reads.
 *
 * Formatted once, here, and then used by all three channels: the bell, the push
 * and the email must not disagree about what was charged.
 *
 * Returns an empty string rather than a placeholder when there is no amount to
 * show — Stripe reports `null` for a session that carried no total, and a
 * hundred-percent discount legitimately reports `0`. The two are different and
 * only the first should disappear from the sentence, so the check is on the
 * type, not on truthiness. Every caller's copy is written to read correctly
 * without it.
 */
const formatMoney = (amount, currency) => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  const code = String(currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: code }).format(amount / 100);
  } catch {
    // `Intl` throws on a currency code it does not recognise rather than
    // degrading, and a receipt is the wrong place to lose the number entirely.
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
};

/**
 * Stripe sends period boundaries as Unix seconds; a Date is also accepted so a
 * caller with one does not have to convert it back.
 */
const formatDate = (value) => {
  if (value === null || value === undefined) return '';
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: 'UTC', dateStyle: 'long' });
};

/**
 * The words for each kind of payment, in one place.
 *
 * One function serves both because the fan-out, the guards and the ordering are
 * identical and only the sentence differs — two copies of this would drift, and
 * the first thing to drift would be the amount.
 */
const copyFor = ({ kind, label, amountLabel, renewsOn }) => {
  const paid = amountLabel ? `Your payment of ${amountLabel} was received.` : 'Your payment was received.';

  if (kind === 'activated') {
    return {
      title: `${label} activated`,
      // Says what changed *and* what happens next: the second half is what stops
      // a monthly subscription being a surprise the following month.
      message: `${paid} ${label} is now active on your account and renews monthly.`,
      pushTitle: 'Parentix — payment successful',
    };
  }

  return {
    title: 'Payment received',
    message: renewsOn
      ? `${paid} ${label} stays active — the next payment is due on ${renewsOn}.`
      : `${paid} ${label} stays active.`,
    pushTitle: 'Parentix — payment received',
  };
};

/**
 * @param {object}  args
 * @param {object=} args.io        Socket.io server, when the caller has one.
 * @param {object}  args.user      The account that paid.
 * @param {string}  args.kind      'activated' (first payment) | 'renewed' (a later one).
 * @param {string=} args.plan      Plan key; falls back to the user's own.
 * @param {number=} args.amount    Stripe minor units.
 * @param {string=} args.currency  ISO code as Stripe reports it.
 * @param {number|Date=} args.periodEnd  When the next payment is due.
 * @param {string=} args.receiptUrl      Stripe's hosted invoice, when there is one.
 * @returns {Promise<boolean>} whether the in-app notification was written.
 */
const notifySubscriptionPayment = async ({
  io, user, kind, plan, amount, currency, periodEnd, receiptUrl,
} = {}) => {
  if (!user?.id) return false;

  const label = planLabel(plan || user.plan || 'premium');
  const amountLabel = formatMoney(amount, currency);
  const renewsOn = formatDate(periodEnd);
  const { title, message, pushTitle } = copyFor({ kind, label, amountLabel, renewsOn });

  let written = false;

  try {
    /**
     * `createdBy` is deliberately left null. The console's "sent notifications"
     * screen lists rows with a `createdBy`, which is how a staff announcement is
     * distinguished from the platform's own messages — a receipt for every
     * customer's monthly payment would bury the announcements it exists to show.
     */
    const row = await Notification.create({ userId: user.id, title, message, type: 'success' });
    written = true;

    // Best effort, and after the write: a socket layer that is unavailable must
    // not turn a stored receipt into a failure. Same room the admin broadcast
    // uses — one row belongs to one account.
    if (io) {
      try {
        io.to(`parent:${user.id}`).emit('notification:new', row);
      } catch {
        /* the row is stored; the bell's poll will find it within the minute */
      }
    }
  } catch (err) {
    logger.error('Payment notification could not be stored', { userId: user.id, kind, error: err.message });
  }

  try {
    if (user.email) {
      const sendEmail = kind === 'activated' ? sendSubscriptionActivatedEmail : sendSubscriptionRenewedEmail;
      // The mailer reports failure by resolving false rather than throwing, so
      // the result is read rather than caught — otherwise an undelivered receipt
      // leaves no trace at all, which is how "no email arrives" goes unnoticed
      // for weeks.
      const delivered = await sendEmail({
        name: user.name, email: user.email, planLabel: label, amountLabel, renewsOn, receiptUrl,
      });
      if (!delivered) {
        logger.error('Payment receipt email was not delivered', { userId: user.id, kind });
      }
    }
  } catch (err) {
    logger.error('Payment receipt email failed', { userId: user.id, kind, error: err.message });
  }

  try {
    await pushService.sendToUser(user.id, {
      title: pushTitle,
      body: message,
      data: { type: 'billing', kind, url: BILLING_DESTINATION },
    });
  } catch (err) {
    logger.error('Payment notification push failed', { userId: user.id, kind, error: err.message });
  }

  return written;
};

module.exports = { notifySubscriptionPayment, formatMoney, BILLING_DESTINATION };
