const { Op } = require('sequelize');
const { Session } = require('../models');
const { sendNewSignInEmail } = require('./email');
const logger = require('./logger');

/**
 * Tells the account holder when their account is signed in to from somewhere new.
 *
 * This is the notification a parent needs in order to discover a compromise at
 * all. Everything else the platform sends is about the child; nothing told the
 * account's owner that someone else had opened it. A stolen password was
 * therefore completely silent — the attacker read locations, messages and
 * contacts, and the only trace was an audit row nobody outside the staff console
 * can see.
 *
 * **Not every sign-in.** A notice on each login is noise, and noise is how this
 * one ends up filtered into a folder nobody opens. It goes out when the user
 * agent making the session has never made one for this account before.
 *
 * **Never on the first.** An account with no earlier session is signing in for
 * the first time — that is the person who just registered, and telling them
 * their brand-new account was accessed from an unrecognised device is both
 * alarming and useless.
 *
 * User agent rather than IP: a phone moving between mobile data and wifi changes
 * address constantly and is the *same* device, so keying on IP would fire
 * several times a day for one person and train them to ignore it. The IP is
 * still reported in the message, where it helps a reader judge.
 */
const notifyNewSignIn = async (req, user, newSessionId) => {
  try {
    // No address on file (phone-only account) means nowhere to send it.
    if (!user.email) return false;

    const userAgent = req.headers?.['user-agent'] || '';
    const ip = req.ip || req.socket?.remoteAddress || '';

    /**
     * Two counts rather than loading the rows.
     *
     * This is on the login path, and sessions are revoked rather than deleted —
     * a long-lived account accumulates them indefinitely, so reading them all
     * back to filter in JavaScript grows with the account's whole history for an
     * answer that is two `SELECT COUNT(*)`s. The session just created is
     * excluded from both: it is not evidence about itself.
     */
    const notThisOne = newSessionId ? { id: { [Op.ne]: newSessionId } } : {};

    const priorCount = await Session.count({ where: { userId: user.id, ...notThisOne } });
    if (priorCount === 0) return false;

    const recognised = await Session.count({
      where: { userId: user.id, userAgent, ...notThisOne },
    });
    if (recognised > 0) return false;

    const delivered = await sendNewSignInEmail({
      name: user.name,
      email: user.email,
      ip,
      userAgent,
      when: new Date(),
    });
    if (!delivered) {
      // Read rather than assumed, like every other send in this codebase: the
      // mailer reports failure by resolving false, so a `.catch` here would be
      // dead code and an undelivered security notice would leave no trace.
      logger.error('New sign-in notification was not delivered', { userId: user.id });
    }
    return delivered;
  } catch (err) {
    // A failed notification must never fail the sign-in that triggered it.
    logger.error('New sign-in notification failed', { userId: user.id, error: err.message });
    return false;
  }
};

module.exports = { notifyNewSignIn };
