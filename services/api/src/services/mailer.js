const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * One `send({ to, subject, html, replyTo })` entry point over two transports:
 *
 *   smtp  — any SMTP relay. This is the production path.
 *   none  — logs the message instead of sending, so development and the test
 *           suite never touch the network.
 *
 * Why no first-party provider: Google Cloud has no equivalent of Amazon SES.
 * Sending mail from GCP means an external relay — SendGrid, Mailgun, Postmark,
 * Resend, or Google Workspace — all of which speak SMTP, so one transport covers
 * every option and no vendor SDK is needed.
 *
 * Two operational notes:
 *
 *   - Compute Engine blocks outbound port 25 permanently and silently. Use 587
 *     (STARTTLS) or 465 (implicit TLS). Cloud Run has no such restriction, but
 *     use 587/465 there too for consistency.
 *   - SMTP_PASS is an API key for most of these providers. Keep it in Secret
 *     Manager and inject it as a secret, never as a plain environment variable.
 */

let transport = null;

const buildSmtpTransport = () => {
  const nodemailer = require('nodemailer');
  const smtp = nodemailer.createTransport({
    host: env.email.smtp.host,
    port: env.email.smtp.port,
    secure: env.email.smtp.secure,
    auth: env.email.smtp.user ? { user: env.email.smtp.user, pass: env.email.smtp.pass } : undefined,
  });

  return async ({ to, subject, html, replyTo }) => {
    await smtp.sendMail({ from: env.email.from, to, subject, html, replyTo });
  };
};

const buildNoopTransport = () => async ({ to, subject }) => {
  logger.info('Email suppressed (no provider configured)', { to, subject });
};

const getTransport = () => {
  if (transport) return transport;

  if (env.email.provider === 'smtp' && env.email.smtp.host) transport = buildSmtpTransport();
  else transport = buildNoopTransport();

  return transport;
};

/** True when a real provider is wired up — callers use it to skip optional mail. */
const isEnabled = () => env.email.provider === 'smtp' && !!env.email.smtp.host;

/**
 * Never throws: a failed notification email must not fail the request that
 * triggered it. Returns whether the message actually went out.
 */
const send = async ({ to, subject, html, replyTo }) => {
  if (!to) return false;
  try {
    await getTransport()({ to, subject, html, replyTo });
    return true;
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    return false;
  }
};

module.exports = { send, isEnabled };
