const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * A message sent through the public contact form.
 *
 * The form used to have no storage at all: it validated, called the mailer, and
 * answered. So a submission existed only as an email in flight — and when the
 * relay was down, or `ADMIN_EMAIL` was simply unset (the default for a
 * deployment nobody had configured), the message was gone. Not delayed, not
 * queued: gone, with the sender told to try again and no record anywhere that
 * they had written at all. For the one form on the site a prospective customer
 * uses to reach a human, that is the wrong order of operations.
 *
 * The row is written first and the notification is sent second. Storage is what
 * makes the answer to "did you get my message?" a fact rather than a hope, and
 * it is what lets a failed send be retried or read out of the database later
 * instead of being lost.
 *
 * `status` records what became of the notification, so an operator can tell the
 * three cases apart without reading logs:
 *
 *   new       stored, notification not attempted yet
 *   notified  the admin mailbox has it
 *   failed    stored, and the notification did not go out — the message is
 *             still here, and `deliveryError` says why
 *   spam      refused by the checks in the controller and kept deliberately, so
 *             a false positive can be found rather than silently discarded
 */
const ContactMessage = sequelize.define('ContactMessage', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },

  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'new' },
  /** Why the notification did not go out. Null while status is not 'failed'. */
  deliveryError: { type: DataTypes.STRING },
  notifiedAt: { type: DataTypes.DATE },
  /** Whether the sender's own acknowledgement was delivered. */
  receiptSent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

  /** Which check refused it, for a message stored as spam. */
  spamReason: { type: DataTypes.STRING },

  /**
   * The submitter's address, hashed rather than stored.
   *
   * It is only ever needed to answer "has this address been submitting
   * repeatedly", which a hash answers exactly as well — and an IP address on a
   * public form is personal data this product has no reason to keep in the
   * clear.
   */
  ipHash: { type: DataTypes.STRING },
  userAgent: { type: DataTypes.STRING },
}, {
  underscored: true,
  indexes: [
    // The operator's list: newest first, optionally by state.
    { fields: ['created_at'] },
    { fields: ['status', 'created_at'] },
    // The duplicate check, which reads one sender's recent submissions.
    { fields: ['email', 'created_at'] },
    { fields: ['ip_hash', 'created_at'] },
  ],
});

module.exports = ContactMessage;
