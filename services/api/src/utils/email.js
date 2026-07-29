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
  ALERT_TYPE_LABELS,
};
