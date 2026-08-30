const crypto = require('node:crypto');
// Called through the module rather than destructured so the sends stay
// interceptable from the tests, as `chatController` does with `pushService`.
const email = require('../utils/email');
const { ContactMessage } = require('../models');
const { classify } = require('../utils/contactSpam');
const { track } = require('../utils/background');
const logger = require('../utils/logger');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME = 120;
const MAX_MESSAGE = 5000;

/**
 * The submitter's address, hashed rather than kept.
 *
 * It is only ever compared — "has this address submitted this before" — and a
 * hash answers that exactly as well as the address does. Salted with the
 * field-encryption key so the hashes are not portable between deployments and a
 * leaked table cannot be reversed against the IPv4 space, which is small enough
 * to enumerate outright.
 */
const hashIp = (ip) => {
  if (!ip) return null;
  const salt = process.env.FIELD_ENCRYPTION_KEY || '';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 64);
};

/**
 * The public "contact us" form on the landing page.
 *
 * ── Order of operations ──────────────────────────────────────────────────────
 * The row is written first and the notification is sent second, and that
 * ordering is the whole design. This used to validate, call the mailer, and
 * answer — so a submission existed only as an email in flight. When the relay
 * was down, or `ADMIN_EMAIL` was unset (the default for a deployment nobody had
 * configured), the message was *gone*, and the sender was told to try again with
 * no record anywhere that they had written.
 *
 * Storing first inverts what a delivery failure means. It is no longer "your
 * message was lost, try again" — the message is safe, and telling someone to
 * resend would produce a duplicate of something already held. It is now an
 * operator's problem, logged as one, while the sender gets the true answer: we
 * have it.
 *
 * The only failure that is still the sender's problem is failing to store, and
 * that is the one case that answers 5xx.
 *
 * ── What is deliberately not awaited ─────────────────────────────────────────
 * Neither email blocks the response. A relay that takes eight seconds should not
 * make the form appear broken when the message is already saved. Both are
 * `track`ed rather than left bare, so shutdown drains them and the tests can
 * wait for them (see utils/background.js).
 */
const submitContactForm = async (req, res) => {
  try {
    // `address`, not `email` — the mailer module is bound to that name here.
    const { name, email: address, message, honeypot, renderedAt } = req.body;

    if (!name || !address || !message) return res.status(400).json({ error: 'All fields required' });
    if (typeof name !== 'string' || typeof address !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'All fields required' });
    }

    const cleanName = name.trim();
    const cleanAddress = address.trim().toLowerCase();
    const cleanMessage = message.trim();

    if (!cleanName || !cleanMessage) return res.status(400).json({ error: 'All fields required' });
    if (!EMAIL_RE.test(cleanAddress)) return res.status(400).json({ error: 'Invalid email address' });
    if (cleanName.length > MAX_NAME) return res.status(400).json({ error: 'Name is too long' });
    if (cleanMessage.length > MAX_MESSAGE) return res.status(400).json({ error: 'Message too long' });

    const ipHash = hashIp(req.ip);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 250) || null;

    const verdict = await classify(
      { name: cleanName, email: cleanAddress, message: cleanMessage, honeypot, renderedAt, ipHash },
      ContactMessage,
    );

    const row = await ContactMessage.create({
      name: cleanName,
      email: cleanAddress,
      message: cleanMessage,
      status: verdict.spam ? 'spam' : 'new',
      spamReason: verdict.spam ? String(verdict.reason).slice(0, 250) : null,
      ipHash,
      userAgent,
    });

    /**
     * A refusal is stored and answered exactly like an acceptance.
     *
     * Every one of these checks can be wrong, and the cost of being wrong is a
     * real customer who believes they reached support and did not. So the
     * message is kept — findable, with the reason it was refused — and the
     * sender is told it was received rather than shown an accusation they have
     * no way to argue with. Telling a bot which check caught it is also the one
     * thing that would let it tune past them.
     *
     * What a refusal costs is the notification, which is the thing being
     * protected.
     */
    if (verdict.spam) {
      logger.warn('Contact form submission held as spam', {
        reference: row.id, reason: verdict.reason, from: cleanAddress,
      });
      return res.status(202).json({ success: true, reference: row.id });
    }

    track(deliver(row));

    // 202, not 200: it is accepted and stored, and the notification is still in
    // flight. The body says the same thing in the words the page shows.
    return res.status(202).json({ success: true, reference: row.id });
  } catch (err) {
    // The one failure that is still the sender's problem: nothing was stored, so
    // trying again is the right advice.
    logger.error('Contact form submission failed', { error: err.message });
    return res.status(500).json({
      error: 'We could not record your message just now. Please try again shortly.',
    });
  }
};

/**
 * Notify the operator, acknowledge the sender, and record what happened to both.
 *
 * The two sends are independent on purpose: a bounced acknowledgement (a typo in
 * the sender's own address, which is common) must not stop the operator being
 * told, and an unconfigured admin mailbox must not deny the sender their
 * receipt. `allSettled`, so neither can reject the other.
 *
 * `includeReceipt` is false when the console retries a failed notification. The
 * sender has already been acknowledged — or has already failed to be, which is
 * recorded — and the thing being retried is the operator's copy. Re-sending the
 * acknowledgement would mail a stranger a second "thanks for your message" for a
 * message they sent once, possibly weeks earlier, which reads as a system out of
 * control rather than one recovering.
 */
const deliver = async (row, { includeReceipt = true } = {}) => {
  const payload = {
    name: row.name, email: row.email, message: row.message, reference: row.id,
  };

  const [notified, receipt] = await Promise.allSettled([
    email.sendContactFormEmail(payload),
    includeReceipt ? email.sendContactFormReceiptEmail(payload) : Promise.resolve(row.receiptSent),
  ]);

  const delivered = notified.status === 'fulfilled' && notified.value === true;
  const receiptSent = receipt.status === 'fulfilled' && receipt.value === true;

  if (!delivered) {
    // Loud, because nobody is being told about a message a customer believes
    // has reached a person. The message itself is safe in the row below.
    logger.error('Contact form notification was not delivered', {
      reference: row.id,
      from: row.email,
      error: notified.status === 'rejected' ? notified.reason?.message : 'mailer reported failure',
    });
  }

  await row.update({
    status: delivered ? 'notified' : 'failed',
    notifiedAt: delivered ? new Date() : null,
    deliveryError: delivered
      ? null
      : String(
        notified.status === 'rejected' ? notified.reason?.message : 'mailer reported failure',
      ).slice(0, 250),
    receiptSent,
  }).catch((err) => logger.error('Could not record contact delivery outcome', {
    reference: row.id, error: err.message,
  }));

  return { delivered, receiptSent };
};

module.exports = { submitContactForm, deliver };
