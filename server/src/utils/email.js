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

module.exports = { sendWelcomeEmail, sendAdminRegistrationNotification };
