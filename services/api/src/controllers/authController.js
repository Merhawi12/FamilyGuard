const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { User } = require('../models');
const { sendWelcomeEmail, sendAdminRegistrationNotification, sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');
const { auditLog } = require('../utils/auditLogger');
const { createSession, revokeSession, revokeAllSessions } = require('../utils/session');
const { serializeUser } = require('../utils/serializers');
const { env } = require('../config/env');
const logger = require('../utils/logger');

const generateVerificationCode = () => String(crypto.randomInt(100000, 1000000));

// Short-lived token used as the first-factor proof before MFA is verified
const signPreAuthToken = (id) =>
  jwt.sign({ id, mfaRequired: true }, env.auth.jwtSecret, { expiresIn: '5m' });

/**
 * Rejects passwords the platform will not accept anywhere — registration,
 * reset, and change all run the same check.
 * @returns {string|null} the reason it was rejected, or null if acceptable.
 */
const passwordProblem = (password) => {
  if (!password || password.length < env.auth.minPasswordLength) {
    return `Password must be at least ${env.auth.minPasswordLength} characters`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
};

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const weak = passwordProblem(password);
    if (weak) return res.status(400).json({ error: weak });

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
      logger.error('Verification email failed', { error: err.message })
    );
    sendAdminRegistrationNotification({ name, email }).catch((err) =>
      logger.error('Admin notification email failed', { error: err.message })
    );

    res.status(201).json({ message: 'Verification code sent to your email', email });
  } catch (err) {
    next(err);
  }
};

const verifyEmail = async (req, res, next) => {
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
      logger.error('Welcome email failed', { error: err.message })
    );

    // Issue a session-bound token, exactly like login does. A bare JWT would
    // have no Session row and could never be revoked by an admin force-logout.
    const { token } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
};

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ where: { email } });

    if (user?.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_locked', metadata: { email } });
      return res.status(423).json({ error: 'Account temporarily locked due to repeated failed logins. Try again later.' });
    }

    if (!user || !(await user.comparePassword(password))) {
      if (user) {
        const attempts = user.failedLoginAttempts + 1;
        const updates = { failedLoginAttempts: attempts };
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
          updates.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
          updates.failedLoginAttempts = 0;
        }
        await user.update(updates);
      }
      auditLog(req, { userId: user?.id, action: 'auth.login_failed', metadata: { email } });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email before logging in', emailVerificationRequired: true });
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await user.update({ failedLoginAttempts: 0, lockedUntil: null });
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
    next(err);
  }
};

const me = async (req, res, next) => {
  res.json(serializeUser(req.user));
};

const logout = async (req, res, next) => {
  try {
    if (req.sessionId) await revokeSession(req.sessionId);
    auditLog(req, { userId: req.user.id, action: 'auth.logout', entity: 'User', entityId: req.user.id });
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
};

const resendCode = async (req, res, next) => {
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
      logger.error('Resend verification email failed', { error: err.message })
    );

    res.json({ message: 'Verification code resent' });
  } catch (err) {
    next(err);
  }
};

const updateProfile = async (req, res, next) => {
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
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });

    const weak = passwordProblem(newPassword);
    if (weak) return res.status(400).json({ error: weak });

    const valid = await req.user.comparePassword(currentPassword);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    await req.user.update({ passwordHash: newPassword });
    auditLog(req, { userId: req.user.id, action: 'auth.password_changed', entity: 'User', entityId: req.user.id });
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
};

const RESET_TOKEN_EXPIRES_MS = 30 * 60 * 1000;

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ where: { email } });
    // Always return the same response so this endpoint can't be used to enumerate accounts
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const passwordResetExpires = new Date(Date.now() + RESET_TOKEN_EXPIRES_MS);
      await user.update({ passwordResetToken: token, passwordResetExpires });

      sendPasswordResetEmail({ name: user.name, email, token }).catch((err) =>
        logger.error('Password reset email failed', { error: err.message })
      );
      auditLog(req, { userId: user.id, action: 'auth.password_reset_requested', entity: 'User', entityId: user.id });
    }

    res.json({ message: 'If an account exists for that email, a reset link has been sent' });
  } catch (err) {
    next(err);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });

    const weak = passwordProblem(newPassword);
    if (weak) return res.status(400).json({ error: weak });

    const user = await User.findOne({ where: { passwordResetToken: token } });
    if (!user || !user.passwordResetExpires || new Date() > new Date(user.passwordResetExpires)) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    await user.update({
      passwordHash: newPassword,
      passwordResetToken: null,
      passwordResetExpires: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    // A reset is the recovery path after a suspected compromise — every existing
    // session has to go, not just the one doing the reset.
    await revokeAllSessions(user.id);

    auditLog(req, { userId: user.id, action: 'auth.password_reset', entity: 'User', entityId: user.id });
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
};

const getNotificationPrefs = async (req, res, next) => {
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
    next(err);
  }
};

const updateNotificationPrefs = async (req, res, next) => {
  try {
    const current = req.user.notificationPrefs ? JSON.parse(req.user.notificationPrefs) : {};
    const updated = { ...current, ...req.body };
    if (req.body.alertTypes) updated.alertTypes = { ...(current.alertTypes || {}), ...req.body.alertTypes };
    await req.user.update({ notificationPrefs: JSON.stringify(updated) });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, me, logout, verifyEmail, resendCode, updateProfile, changePassword, forgotPassword, resetPassword, getNotificationPrefs, updateNotificationPrefs };
