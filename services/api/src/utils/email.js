const { env } = require('../config/env');
const { send, isEnabled } = require('../services/mailer');
const logger = require('./logger');

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])
  );

const layout = (body) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto;color:#1e293b;">
    ${body}
    <p style="margin-top:28px;color:#94a3b8;font-size:.8rem;">— The Parentix Team</p>
  </div>
`;

const sendWelcomeEmail = ({ name, email }) =>
  send({
    to: email,
    subject: 'Welcome to Parentix!',
    html: layout(`
      <h2>Hi ${escapeHtml(name)}, welcome to Parentix!</h2>
      <p>Your account has been created successfully.</p>
      <p>You have a <strong>7-day free trial</strong> — enjoy full access while you get started.</p>
      <p>If you have any questions, just reply to this email.</p>
    `),
  });

const sendAdminRegistrationNotification = ({ name, email }) => {
  if (!env.email.adminAddress) return Promise.resolve(false);
  return send({
    to: env.email.adminAddress,
    subject: 'New User Registered',
    html: layout(`
      <h2>New Registration</h2>
      <ul>
        <li><strong>Name:</strong> ${escapeHtml(name)}</li>
        <li><strong>Email:</strong> ${escapeHtml(email)}</li>
        <li><strong>Date:</strong> ${new Date().toUTCString()}</li>
      </ul>
    `),
  });
};

const sendVerificationEmail = ({ name, email, code }) => {
  if (!isEnabled()) {
    // Without a provider there is no other way to finish signup locally.
    logger.info('Verification code (email disabled)', { email, code });
    return Promise.resolve(false);
  }
  return send({
    to: email,
    subject: 'Verify your Parentix account',
    html: layout(`
      <h2>Hi ${escapeHtml(name)},</h2>
      <p>Your verification code is:</p>
      <h1 style="letter-spacing:8px;font-size:40px;color:#4F46E5">${escapeHtml(code)}</h1>
      <p>This code expires in <strong>15 minutes</strong>.</p>
      <p>If you didn't create an account, you can ignore this email.</p>
    `),
  });
};

/**
 * A code, where there used to be a link.
 *
 * A reset link is a credential in a URL: it is logged by every mail gateway and
 * link scanner it passes, it survives in browser history, and it works for
 * anyone who reaches it — including the corporate filter that "checked" the
 * message by fetching it. Six digits go to the same inbox but have to be carried
 * back to a screen someone is already looking at, which is also what lets the
 * whole flow finish in the app rather than punting between the app and a browser.
 *
 * The line logged when there is no relay is what makes the flow completable in
 * development, and is the same shape as the verification-code one above.
 */
const sendPasswordResetCodeEmail = ({ name, email, code }) => {
  if (!isEnabled()) {
    logger.info('Password reset code (email disabled)', { email, code });
    return Promise.resolve(false);
  }

  return send({
    to: email,
    subject: 'Your Parentix password reset code',
    html: layout(`
      <h2>Hi ${escapeHtml(name)},</h2>
      <p>We received a request to reset your Parentix password. Enter this code to continue:</p>
      <h1 style="letter-spacing:8px;font-size:40px;color:#4F46E5">${escapeHtml(code)}</h1>
      <p>This code expires in <strong>15 minutes</strong> and can be used once.</p>
      <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `),
  });
};

/**
 * The two account-security notices, and why they are not alert emails.
 *
 * `notificationPrefs` governs what a parent hears about their *child* — safe
 * zones, screen time, flagged messages — and every entry there is optional
 * because an inbox full of `blocked_app_attempt` is how people learn to ignore
 * the rest. These two are about the parent's own account, and they are the
 * mechanism by which someone finds out a stranger is in it. They are therefore
 * deliberately not switchable: an attacker who reaches the settings screen would
 * otherwise turn off the notice that reports them.
 *
 * Both address the account holder, so both are silent no-ops for a phone-only
 * account with no email on file — `send` returns false on a missing recipient.
 */
const formatWhen = (date) =>
  new Date(date).toLocaleString('en-CA', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';

const sendNewSignInEmail = ({ name, email, ip, userAgent, when }) =>
  send({
    to: email,
    subject: 'New sign-in to your Parentix account',
    html: layout(`
      <h2>Hi ${escapeHtml(name)},</h2>
      <p>Your Parentix account was just signed in to from a device we haven't seen before.</p>
      <ul style="line-height:1.7;color:#334155;">
        <li><strong>When:</strong> ${escapeHtml(formatWhen(when || Date.now()))}</li>
        <li><strong>IP address:</strong> ${escapeHtml(ip || 'unknown')}</li>
        <li><strong>Device:</strong> ${escapeHtml(userAgent || 'unknown')}</li>
      </ul>
      <p>If this was you, no action is needed.</p>
      <p><strong>If it wasn't</strong>, change your password immediately — that signs out every other
      device — and turn on two-factor authentication in Settings.</p>
    `),
  });

const sendPasswordChangedEmail = ({ name, email, when, viaReset }) =>
  send({
    to: email,
    subject: 'Your Parentix password was changed',
    html: layout(`
      <h2>Hi ${escapeHtml(name)},</h2>
      <p>The password on your Parentix account was ${viaReset ? 'reset' : 'changed'} on
      ${escapeHtml(formatWhen(when || Date.now()))}.</p>
      <p>Every other signed-in device has been signed out.</p>
      <p><strong>If you didn't do this</strong>, use "Forgot password" to take the account back, then
      contact us straight away.</p>
    `),
  });

const ALERT_TYPE_LABELS = {
  left_safe_zone: 'Left Safe Zone',
  entered_safe_zone: 'Arrived at Safe Zone',
  dangerous_content: 'Risky Site Opened',
  emergency_button: 'Emergency Alert',
  cyberbullying: 'Cyberbullying Detected',
  screen_time_exceeded: 'Screen Time Exceeded',
  blocked_app: 'Blocked App Attempt',
  blocked_app_attempt: 'Blocked App Attempt',
  app_installed: 'New App Used',
  safety_pattern: 'Safety Pattern Detected',
};

const sendAlertEmail = ({ name, email, type, message, severity }) => {
  const label = ALERT_TYPE_LABELS[type] || type;
  const color = severity === 'high' ? '#DC2626' : severity === 'medium' ? '#D97706' : '#2563EB';

  return send({
    to: email,
    subject: `⚠️ Parentix Alert: ${label}`,
    html: layout(`
      <h2>Parentix Alert</h2>
      <div style="background:#f8fafc;border-left:4px solid ${color};padding:16px 20px;border-radius:4px;margin:16px 0;">
        <p style="margin:0 0 6px;font-weight:700;color:${color};">${escapeHtml(label)}</p>
        <p style="margin:0;color:#334155;">${escapeHtml(message)}</p>
      </div>
      <p style="color:#64748b;font-size:.9rem;">Hi ${escapeHtml(name)}, this alert was triggered on your Parentix dashboard. Log in to review the details.</p>
    `),
  });
};

/**
 * The operator's copy of a contact-form submission.
 *
 * `replyTo` is the sender, so hitting reply in the mailbox answers the person
 * rather than the no-reply address the platform sends from. `reference` is the
 * stored row's id: the message is in the database whether or not this email
 * arrives, and quoting the id is what connects the two when someone has to go
 * looking.
 */
const sendContactFormEmail = ({ name, email, message, reference }) => {
  if (!env.email.adminAddress) {
    // No longer the message's only trace — it is stored before this is called —
    // but still worth saying plainly, because it means nobody is being told.
    logger.error('Contact form message stored but ADMIN_EMAIL is not configured', {
      reference, from: email,
    });
    return Promise.resolve(false);
  }

  return send({
    to: env.email.adminAddress,
    replyTo: email,
    subject: `New Contact Form Message from ${name}`,
    html: layout(`
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
      ${reference ? `<p style="color:#94a3b8;font-size:.8rem;">Reference ${escapeHtml(reference)}</p>` : ''}
    `),
  });
};

/**
 * The sender's own copy, so "did that go through?" has an answer in their inbox.
 *
 * The form said "Thanks! Your message has been sent" on the page and nothing
 * ever followed it. Someone who closed the tab had no evidence they had written
 * at all, and no reference to quote if they had to chase it.
 *
 * Their message is quoted back deliberately: it is the only copy they have, and
 * a support desk that can show you what it received is one you can correct.
 *
 * `replyTo` is the admin mailbox — a person answering this acknowledgement is
 * continuing the conversation, and it should reach a human rather than bounce
 * off no-reply.
 */
const sendContactFormReceiptEmail = ({ name, email, message, reference }) =>
  send({
    to: email,
    ...(env.email.adminAddress && { replyTo: env.email.adminAddress }),
    subject: 'We received your message — Parentix',
    html: layout(`
      <h2>Thanks for getting in touch</h2>
      <p>Hi ${escapeHtml(name)}, we have your message and someone will reply to this
         address. There is nothing else you need to do.</p>
      <div style="background:#f8fafc;border-left:4px solid #0E7C86;padding:16px 20px;border-radius:4px;margin:16px 0;">
        <p style="margin:0;color:#334155;white-space:pre-wrap;">${escapeHtml(message)}</p>
      </div>
      ${reference ? `<p style="color:#94a3b8;font-size:.8rem;">Reference ${escapeHtml(reference)}</p>` : ''}
      <p style="color:#64748b;font-size:.9rem;">If you did not send this, you can ignore it —
         nothing has been created and no account has been changed.</p>
    `),
  });

module.exports = {
  sendWelcomeEmail,
  sendAdminRegistrationNotification,
  sendVerificationEmail,
  sendAlertEmail,
  sendContactFormEmail,
  sendContactFormReceiptEmail,
  sendPasswordResetCodeEmail,
  sendNewSignInEmail,
  sendPasswordChangedEmail,
  ALERT_TYPE_LABELS,
};
