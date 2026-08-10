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

const sendPasswordResetEmail = ({ name, email, token }) => {
  const resetUrl = `${env.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;

  if (!isEnabled()) {
    logger.info('Password reset link (email disabled)', { email, resetUrl });
    return Promise.resolve(false);
  }

  return send({
    to: email,
    subject: 'Reset your Parentix password',
    html: layout(`
      <h2>Hi ${escapeHtml(name)},</h2>
      <p>We received a request to reset your Parentix password. Click below to choose a new one:</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:#4F46E5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Reset Password</a></p>
      <p>This link expires in <strong>30 minutes</strong>.</p>
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
  dangerous_content: 'Dangerous Content Detected',
  emergency_button: 'Emergency Alert',
  cyberbullying: 'Cyberbullying Detected',
  screen_time_exceeded: 'Screen Time Exceeded',
  blocked_app: 'Blocked App Attempt',
  blocked_app_attempt: 'Blocked App Attempt',
  app_installed: 'New App Installed',
  unknown_contact: 'Unknown Contact',
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

const sendContactFormEmail = ({ name, email, message }) => {
  if (!env.email.adminAddress) {
    logger.info('Contact form received (no ADMIN_EMAIL configured)', { name, email });
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
    `),
  });
};

module.exports = {
  sendWelcomeEmail,
  sendAdminRegistrationNotification,
  sendVerificationEmail,
  sendAlertEmail,
  sendContactFormEmail,
  sendPasswordResetEmail,
  sendNewSignInEmail,
  sendPasswordChangedEmail,
  ALERT_TYPE_LABELS,
};
