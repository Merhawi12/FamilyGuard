const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { sendWelcomeEmail, sendAdminRegistrationNotification, sendVerificationEmail } = require('../utils/email');
const { auditLog } = require('../utils/auditLogger');
const { createSession, revokeSession } = require('../utils/session');

const generateVerificationCode = () =>
  String(Math.floor(100000 + Math.random() * 900000));

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// Short-lived token used as the first-factor proof before MFA is verified
const signPreAuthToken = (id) =>
  jwt.sign({ id, mfaRequired: true }, process.env.JWT_SECRET, { expiresIn: '5m' });

const serializeUser = (user) => {
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt).toISOString() : null;
  const trialExpired = trialEndsAt && new Date() > new Date(trialEndsAt);
  return { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, trialEndsAt, trialExpired, mfaEnabled: user.mfaEnabled };
};

const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const code = generateVerificationCode();
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const emailVerificationExpires = new Date(Date.now() + 15 * 60 * 1000);

    const user = await User.create({
      name, email, passwordHash: password, trialEndsAt,
      emailVerificationCode: code,
      emailVerificationExpires,
    });

    auditLog(req, { userId: user.id, action: 'auth.register', entity: 'User', entityId: user.id, metadata: { email } });

    sendVerificationEmail({ name, email, code }).catch((err) =>
      console.error('Verification email failed:', err.message)
    );
    sendAdminRegistrationNotification({ name, email }).catch((err) =>
      console.error('Admin notification email failed:', err.message)
    );

    res.status(201).json({ message: 'Verification code sent to your email', email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' });

    if (
      user.emailVerificationCode !== String(code) ||
      !user.emailVerificationExpires ||
      new Date() > new Date(user.emailVerificationExpires)
    ) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    await user.update({
      emailVerified: true,
      emailVerificationCode: null,
      emailVerificationExpires: null,
    });

    auditLog(req, { userId: user.id, action: 'auth.email_verified', entity: 'User', entityId: user.id });

    sendWelcomeEmail({ name: user.name, email }).catch((err) =>
      console.error('Welcome email failed:', err.message)
    );

    const token = signToken(user.id);
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ where: { email } });
    if (!user || !(await user.comparePassword(password))) {
      auditLog(req, { userId: user?.id, action: 'auth.login_failed', metadata: { email } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email before logging in', emailVerificationRequired: true });
    }

    if (user.mfaEnabled) {
      const preAuthToken = signPreAuthToken(user.id);
      auditLog(req, { userId: user.id, action: 'auth.mfa_challenge', entity: 'User', entityId: user.id });
      return res.json({ mfaRequired: true, preAuthToken });
    }

    const { token } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    auditLog(req, { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id });
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const me = async (req, res) => {
  res.json(serializeUser(req.user));
};

const logout = async (req, res) => {
  try {
    if (req.sessionId) await revokeSession(req.sessionId);
    auditLog(req, { userId: req.user.id, action: 'auth.logout', entity: 'User', entityId: req.user.id });
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const resendCode = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' });

    const code = generateVerificationCode();
    const emailVerificationExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.update({ emailVerificationCode: code, emailVerificationExpires });

    sendVerificationEmail({ name: user.name, email, code }).catch((err) =>
      console.error('Resend verification email failed:', err.message)
    );

    res.json({ message: 'Verification code resent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name && !email) return res.status(400).json({ error: 'Nothing to update' });

    const updates = {};
    if (name) updates.name = name.trim();
    if (email && email !== req.user.email) {
      const existing = await User.findOne({ where: { email } });
      if (existing) return res.status(409).json({ error: 'Email already in use' });
      updates.email = email.trim();
    }

    await req.user.update(updates);
    auditLog(req, { userId: req.user.id, action: 'auth.profile_updated', entity: 'User', entityId: req.user.id });
    res.json(serializeUser(req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const valid = await req.user.comparePassword(currentPassword);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    await req.user.update({ passwordHash: newPassword });
    auditLog(req, { userId: req.user.id, action: 'auth.password_changed', entity: 'User', entityId: req.user.id });
    res.json({ message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getNotificationPrefs = async (req, res) => {
  try {
    const prefs = req.user.notificationPrefs ? JSON.parse(req.user.notificationPrefs) : {};
    const defaults = {
      emailAlerts: true,
      emailHighOnly: true,
      alertTypes: {
        left_safe_zone: true,
        dangerous_content: true,
        emergency_button: true,
        cyberbullying: true,
        safety_pattern: true,
        screen_time_exceeded: true,
        blocked_app_attempt: false,
        app_installed: false,
        unknown_contact: true,
      },
    };
    res.json({ ...defaults, ...prefs, alertTypes: { ...defaults.alertTypes, ...(prefs.alertTypes || {}) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateNotificationPrefs = async (req, res) => {
  try {
    const current = req.user.notificationPrefs ? JSON.parse(req.user.notificationPrefs) : {};
    const updated = { ...current, ...req.body };
    if (req.body.alertTypes) updated.alertTypes = { ...(current.alertTypes || {}), ...req.body.alertTypes };
    await req.user.update({ notificationPrefs: JSON.stringify(updated) });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { register, login, me, logout, verifyEmail, resendCode, updateProfile, changePassword, getNotificationPrefs, updateNotificationPrefs };
