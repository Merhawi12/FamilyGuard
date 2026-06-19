const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const ADMIN_EMAIL = 'samera3031@gmail.com';

const sendWelcomeEmail = async ({ name, email }) => {
  if (!process.env.SMTP_HOST) return;

  await transporter.sendMail({
    from: `"FamilyGuard" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: 'Welcome to FamilyGuard!',
    html: `
      <h2>Hi ${name}, welcome to FamilyGuard!</h2>
      <p>Your account has been created successfully.</p>
      <p>You have a <strong>7-day free trial</strong> — enjoy full access while you get started.</p>
      <p>If you have any questions, just reply to this email.</p>
      <br/>
      <p>— The FamilyGuard Team</p>
    `,
  });
};

const sendAdminRegistrationNotification = async ({ name, email }) => {
  if (!process.env.SMTP_HOST) return;

  await transporter.sendMail({
    from: `"FamilyGuard" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: ADMIN_EMAIL,
    subject: 'New User Registered',
    html: `
      <h2>New Registration</h2>
      <p>A new user has signed up for FamilyGuard:</p>
      <ul>
        <li><strong>Name:</strong> ${name}</li>
        <li><strong>Email:</strong> ${email}</li>
        <li><strong>Date:</strong> ${new Date().toUTCString()}</li>
      </ul>
    `,
  });
};

const sendVerificationEmail = async ({ name, email, code }) => {
  if (!process.env.SMTP_HOST) {
    console.log(`[DEV] Verification code for ${email}: ${code}`);
    return;
  }

  await transporter.sendMail({
    from: `"FamilyGuard" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: 'Verify your FamilyGuard account',
    html: `
      <h2>Hi ${name},</h2>
      <p>Your verification code is:</p>
      <h1 style="letter-spacing:8px;font-size:40px;color:#4F46E5">${code}</h1>
      <p>This code expires in <strong>15 minutes</strong>.</p>
      <p>If you didn't create an account, you can ignore this email.</p>
      <br/>
      <p>— The FamilyGuard Team</p>
    `,
  });
};

const ALERT_TYPE_LABELS = {
  left_safe_zone: 'Left Safe Zone',
  entered_safe_zone: 'Arrived at Safe Zone',
  dangerous_content: 'Dangerous Content Detected',
  emergency_button: 'Emergency Alert',
  cyberbullying: 'Cyberbullying Detected',
  screen_time_exceeded: 'Screen Time Exceeded',
  blocked_app_attempt: 'Blocked App Attempt',
  app_installed: 'New App Installed',
  unknown_contact: 'Unknown Contact',
  safety_pattern: 'Safety Pattern Detected',
};

const sendAlertEmail = async ({ name, email, type, message, severity }) => {
  if (!process.env.SMTP_HOST) return;

  const label = ALERT_TYPE_LABELS[type] || type;
  const color = severity === 'high' ? '#DC2626' : severity === 'medium' ? '#D97706' : '#2563EB';

  await transporter.sendMail({
    from: `"FamilyGuard" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: `⚠️ FamilyGuard Alert: ${label}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;">
        <h2 style="color:#1e293b;">FamilyGuard Alert</h2>
        <div style="background:#f8fafc;border-left:4px solid ${color};padding:16px 20px;border-radius:4px;margin:16px 0;">
          <p style="margin:0 0 6px;font-weight:700;color:${color};">${label}</p>
          <p style="margin:0;color:#334155;">${message}</p>
        </div>
        <p style="color:#64748b;font-size:.9rem;">Hi ${name}, this alert was triggered on your FamilyGuard dashboard. Log in to review the details.</p>
        <p style="margin-top:24px;color:#94a3b8;font-size:.8rem;">— The FamilyGuard Team</p>
      </div>
    `,
  });
};

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sendContactFormEmail = async ({ name, email, message }) => {
  if (!process.env.SMTP_HOST) {
    console.log(`[DEV] Contact form from ${name} <${email}>: ${message}`);
    return;
  }

  await transporter.sendMail({
    from: `"FamilyGuard" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: ADMIN_EMAIL,
    replyTo: email,
    subject: `New Contact Form Message from ${name}`,
    html: `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
    `,
  });
};

module.exports = { sendWelcomeEmail, sendAdminRegistrationNotification, sendVerificationEmail, sendAlertEmail, sendContactFormEmail };
