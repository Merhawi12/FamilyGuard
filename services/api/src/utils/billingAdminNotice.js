const { Op } = require('sequelize');
const { AuditLog, Notification, User } = require('../models');
const { STAFF_ROLES, PERMISSIONS, hasPermission } = require('../config/roles');
const { planLabel } = require('../config/plans');
const { formatMoney } = require('./billingNotice');
const logger = require('./logger');

/**
 * Telling the platform's own staff that money moved.
 *
 * `billingNotice.js` tells the customer. Nothing told anyone here: a sale, a
 * renewal, a failed card and a cancellation all landed as a row in a table
 * somebody had to think to open. The Billing screen answers "how are we doing"
 * when you go and ask it, and there was no version of "a customer just
 * subscribed" that arrived on its own.
 *
 * Two channels, because they answer different questions:
 *
 *   audit    an `AuditLog` entry, which is what puts the event on the System
 *            Logs screen and into the Overview's counts. It is the durable
 *            record, it is filterable, and a failed payment classifies as an
 *            error there without anything extra — `_failed` is an error suffix
 *            (see utils/logSeverity.js).
 *   in-app   a `Notification` row for every staff account that can actually act
 *            on it, which is what the console's bell reads.
 *
 * **Who gets it is a permission, not a role.** `manage_billing` is what opens
 * the Billing screen, so it is exactly the set of people for whom a payment is
 * their job — Finance by default, Super Admin implicitly, and anyone a Super
 * Admin has granted it to. Sending to every staff account instead would put a
 * customer's payment in front of Marketing, who cannot open the screen it links
 * to.
 *
 * **Called once per payment, and only by the writer of the transaction row.**
 * Every caller is gated on `recordTransaction` having inserted, which is the
 * same gate the customer's receipt uses — so a redelivered webhook, or the
 * customer's return from Checkout racing the webhook, produces one entry here
 * and not two. See `recordTransaction` in routes/payments.js.
 *
 * Never throws, and is never awaited by a request handler. This runs off the
 * back of a settled payment; a notification failure must not turn a successful
 * charge into a 5xx that Stripe then retries.
 */

/** Where a staff notification should take the reader. */
const BILLING_SCREEN = '/billing';

/**
 * The words and the severity for each kind of billing event.
 *
 * `action` is what the System Logs screen classifies and filters on. The names
 * follow the `service.event` shape every other audit action uses, so `billing`
 * becomes a service in the filter row alongside `auth` and `admin`.
 */
const KINDS = {
  activated: {
    action: 'billing.payment_received',
    type: 'success',
    title: 'New Premium subscription',
    sentence: (who, what) => `${who} subscribed to ${what}.`,
  },
  renewed: {
    action: 'billing.payment_received',
    type: 'success',
    title: 'Subscription renewed',
    sentence: (who, what) => `${who} renewed ${what}.`,
  },
  failed: {
    // `_failed` is an error suffix in utils/logSeverity.js, so this lands on the
    // System Logs error filter and in the Overview's error count without any
    // rule being added for it.
    action: 'billing.payment_failed',
    type: 'warning',
    title: 'Payment failed',
    sentence: (who, what) => `A ${what} payment from ${who} did not go through.`,
  },
  cancelled: {
    action: 'billing.subscription_cancelled',
    type: 'warning',
    title: 'Subscription cancelled',
    sentence: (who, what) => `${who} cancelled ${what}.`,
  },
};

/**
 * The staff who should hear about a payment.
 *
 * Read on each event rather than cached: the set changes when a Super Admin
 * grants or withdraws the permission, and billing events are rare enough that a
 * query over the staff table — a few dozen rows at most — costs nothing against
 * the Stripe round trip that preceded it.
 *
 * Deactivated accounts are excluded. A suspended staff account cannot sign in to
 * read the notification, and filling its bell is how an unread count becomes
 * meaningless.
 */
const billingStaff = async () => {
  const staff = await User.findAll({
    where: { role: { [Op.in]: STAFF_ROLES }, isActive: true },
    attributes: ['id', 'role', 'permissions'],
  });
  return staff.filter((member) => hasPermission(member, PERMISSIONS.MANAGE_BILLING));
};

/**
 * @param {object}  args
 * @param {object=} args.io        Socket.io server, when the caller has one.
 * @param {object}  args.user      The customer the event is about.
 * @param {string}  args.kind      'activated' | 'renewed' | 'failed' | 'cancelled'.
 * @param {string=} args.plan      Plan key; falls back to the customer's own.
 * @param {number=} args.amount    Stripe minor units.
 * @param {string=} args.currency  ISO code as Stripe reports it.
 * @param {string=} args.reference The transaction's dedupe key, so an operator
 *                                 can tie the entry to the row and to Stripe.
 * @returns {Promise<number>} how many staff notifications were written.
 */
const notifyStaffOfBillingEvent = async ({
  io, user, kind, plan, amount, currency, reference,
} = {}) => {
  const shape = KINDS[kind];
  if (!user?.id || !shape) return 0;

  const label = planLabel(plan || user.plan || 'premium');
  const amountLabel = formatMoney(amount, currency);
  // The account, as an operator would identify it. Email first because that is
  // what the Billing screen's search matches on; a phone-only account has none.
  const who = user.email || user.name || `account ${user.id}`;
  const what = amountLabel ? `${label} (${amountLabel})` : label;
  const message = shape.sentence(who, what);

  /**
   * The audit entry first, and independently of the notifications.
   *
   * It is the durable half — the one an operator can still find in six months,
   * and the one the Overview counts — so it must not be lost because the staff
   * lookup failed or because nobody currently holds the permission.
   */
  try {
    await AuditLog.create({
      // No actor: a customer paying is not a staff action, and attributing it to
      // the customer would put a payment in their own admin activity trail.
      userId: null,
      action: shape.action,
      entity: 'Transaction',
      metadata: {
        customerId: user.id,
        customerEmail: user.email || null,
        plan: plan || user.plan || null,
        amount: typeof amount === 'number' ? amount : null,
        currency: currency || null,
        // The `stripeEventId` of the row this describes: the one string that
        // ties the audit entry, the transaction and Stripe's own dashboard
        // together.
        reference: reference || null,
      },
    });
  } catch (err) {
    logger.error('Billing audit entry could not be written', { kind, userId: user.id, error: err.message });
  }

  let written = 0;
  try {
    const staff = await billingStaff();
    if (staff.length === 0) {
      // Not an error — a deployment can legitimately have no finance account —
      // but it does mean the in-app half reached nobody, and the audit entry
      // above is then the only record.
      logger.warn('No staff hold manage_billing — billing notification filed to the audit log only', { kind });
      return 0;
    }

    const rows = await Notification.bulkCreate(
      staff.map((member) => ({
        userId: member.id,
        title: shape.title,
        message,
        type: shape.type,
        // Straight to the screen this is about. A payment notice a finance
        // operator cannot open the payment log from is a dead end.
        link: BILLING_SCREEN,
        /**
         * `createdBy` stays null, as it does for a customer's own receipt. The
         * console's "sent notifications" screen lists rows that have one, which
         * is how a staff announcement is told apart from the platform's own
         * messages — a payment notice is the platform speaking, not an operator.
         */
      })),
      { returning: true },
    );
    written = rows.length;

    // Best effort and after the write. The console polls for these, so a socket
    // layer that is unavailable costs a few seconds of latency, not the notice.
    if (io) {
      for (const row of rows) {
        try {
          io.to(`parent:${row.userId}`).emit('notification:new', row);
        } catch {
          /* one undeliverable socket must not abort the rest */
        }
      }
    }
  } catch (err) {
    logger.error('Billing staff notification failed', { kind, userId: user.id, error: err.message });
  }

  return written;
};

module.exports = { notifyStaffOfBillingEvent, BILLING_SCREEN };
