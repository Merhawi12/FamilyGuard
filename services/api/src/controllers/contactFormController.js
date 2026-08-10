// Called through the module rather than destructured so the send stays
// interceptable from the tests, as `chatController` does with `pushService`.
const email = require('../utils/email');
const logger = require('../utils/logger');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The public "contact us" form on the landing page.
 *
 * The delivery result is read, not discarded. `sendContactFormEmail` reports
 * failure by resolving false rather than throwing — it does so for a send that
 * was rejected by the relay, and also when `ADMIN_EMAIL` is simply not set,
 * which is the *default* for a deployment nobody has configured. Answering
 * `{ success: true }` regardless meant a prospective customer saw "message
 * sent", closed the tab, and waited for a reply to a message that had been
 * written to a log line and nowhere else.
 *
 * This is the same "a failed request rendered as good news" shape the
 * registration and password-reset paths were already fixed for, and it is
 * answered the same way: say what happened, and log it where an operator will
 * see it. 502 rather than 500 — nothing here is broken, the relay downstream is
 * unavailable or unconfigured.
 */
const submitContactForm = async (req, res) => {
  try {
    // `address`, not `email` — the mailer module is bound to that name here.
    const { name, email: address, message } = req.body;
    if (!name || !address || !message) return res.status(400).json({ error: 'All fields required' });
    if (!EMAIL_RE.test(address)) return res.status(400).json({ error: 'Invalid email address' });
    if (message.length > 5000) return res.status(400).json({ error: 'Message too long' });

    const delivered = await email.sendContactFormEmail({ name, email: address, message });

    if (!delivered) {
      logger.error('Contact form message was not delivered', { from: address });
      return res.status(502).json({
        error: 'We could not send your message just now. Please email us directly, or try again shortly.',
        delivered: false,
      });
    }

    return res.json({ success: true, delivered: true });
  } catch (err) {
    // Logged rather than swallowed: this used to answer 500 with the reason
    // visible nowhere at all.
    logger.error('Contact form submission failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to send message' });
  }
};

module.exports = { submitContactForm };
