const { Op } = require('sequelize');
const { ContactMessage } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { likeOperator } = require('../utils/queryOperators');
const { dateRangeWhere } = require('../utils/dateRange');
const { auditLog } = require('../utils/auditLogger');
const { deliver } = require('./contactFormController');

/**
 * The console's view of the public contact form's inbox.
 *
 * `POST /api/contact` has stored the message before attempting any email since
 * 2026-08-14, precisely so a dead relay or a spam verdict costs the notification
 * and never the message. That guarantee had no way to be collected: the model
 * was written by the form, read by the duplicate check, deleted by account
 * erasure, and shown to nobody. When an operator reported receiving no contact
 * email, the honest answer was "your messages are safe, and unreachable" — the
 * worst half of both properties.
 *
 * These three endpoints are the missing half. The one that matters most is
 * `resend`: a backlog held as `failed` while SMTP was down is recoverable in
 * bulk once it is fixed, which is the whole point of having stored them.
 */

/**
 * What an operator may set a message to, and what those two mean.
 *
 * Deliberately not the full set. `notified` and `failed` are *findings* — they
 * record what the mailer actually did — and letting a human type one in would
 * make the column a mixture of observation and opinion, so that "failed" no
 * longer reliably means "nobody was told". Those two are written by `deliver`
 * alone.
 *
 *   new       this is not spam after all; put it back in the queue
 *   archived  dealt with, stop showing it in the default view
 */
const SETTABLE = ['new', 'archived'];

/** Every state a row can be in, for the summary tiles. */
const ALL_STATUSES = ['new', 'notified', 'failed', 'spam', 'archived'];

const listWhere = ({ q, status, from, to }) => {
  const where = {};
  const and = [];

  if (status) and.push({ status });

  if (q) {
    // Case-insensitive for the dialect in use: SQLite's LIKE ignores ASCII case
    // and Postgres' does not, so a plain Op.like passes the suite and then fails
    // to find "Wilhelmina" for an operator who typed "wilhelmina".
    const contains = { [likeOperator()]: `%${q}%` };
    and.push({ [Op.or]: [{ name: contains }, { email: contains }, { message: contains }] });
  }

  const range = dateRangeWhere(from, to, { Op });
  if (range) where.createdAt = range;
  if (and.length) where[Op.and] = and;

  return where;
};

/**
 * GET /admin/contact-messages
 *
 * The summary counts every message on the platform and ignores every filter, by
 * the same rule as the user and device directories: the tiles describe the
 * inbox, so they must not move when the table below is narrowed. An operator
 * filtering to `failed` needs to keep seeing how many that is out of how many.
 */
const listMessages = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 25 });

    const [result, totals] = await Promise.all([
      ContactMessage.findAndCountAll({
        where: listWhere(req.query),
        // `ipHash` and `userAgent` are excluded at the query rather than dropped
        // after it. They exist for the duplicate check, not for a person to
        // read, and the screen has no use for them that would justify putting a
        // submitter's fingerprint on a page — so the safest place for that
        // decision is the one where forgetting it cannot leak them.
        attributes: { exclude: ['ipHash', 'userAgent'] },
        order: [['createdAt', 'DESC']],
        limit,
        offset,
      }),
      ContactMessage.findAll({
        attributes: ['status', [ContactMessage.sequelize.fn('COUNT', '*'), 'n']],
        group: ['status'],
        raw: true,
      }),
    ]);

    const counted = Object.fromEntries(totals.map((r) => [r.status, Number(r.n) || 0]));
    const summary = Object.fromEntries(ALL_STATUSES.map((s) => [s, counted[s] || 0]));
    summary.total = Object.values(counted).reduce((a, b) => a + b, 0);

    res.json({
      count: result.count,
      rows: result.rows.map((row) => row.toJSON()),
      summary,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /admin/contact-messages/:id — restore a false positive, or archive.
 *
 * Audited, because un-spamming is the decision that puts a stranger's message
 * back in front of staff and archiving is the one that takes it away.
 */
const updateMessage = async (req, res, next) => {
  try {
    const row = await ContactMessage.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Message not found' });

    const { status } = req.body;
    if (!SETTABLE.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${SETTABLE.join(', ')}` });
    }

    const previous = row.status;
    // Clearing `spamReason` on the way out matters: leaving it would keep the
    // row explaining why it was refused after somebody decided it was not.
    await row.update({ status, ...(status === 'new' ? { spamReason: null } : {}) });

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.contact_message_updated',
      entity: 'ContactMessage',
      entityId: row.id,
      metadata: { from: previous, to: status },
    });

    return res.json({ id: row.id, status: row.status });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /admin/contact-messages/:id/resend — try the operator notification again.
 *
 * The sender's acknowledgement is not re-sent; see `deliver`. The response
 * reports what happened rather than simply 200-ing, because "retry succeeded"
 * and "retry failed the same way" are the two answers an operator is asking for,
 * and the second one carries the reason.
 */
const resendNotification = async (req, res, next) => {
  try {
    const row = await ContactMessage.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Message not found' });

    const { delivered } = await deliver(row, { includeReceipt: false });
    await row.reload();

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.contact_notification_resent',
      entity: 'ContactMessage',
      entityId: row.id,
      metadata: { delivered },
    });

    return res.json({
      id: row.id,
      status: row.status,
      delivered,
      deliveryError: row.deliveryError || null,
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = { listMessages, updateMessage, resendNotification, SETTABLE, ALL_STATUSES };
