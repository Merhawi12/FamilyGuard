/**
 * otplib v13 is a rewrite: the `authenticator` singleton this controller was
 * originally written against no longer exists, and TOTP is now a functional,
 * async API. Every call here went through that removed object, so each of these
 * routes threw `Cannot read properties of undefined` — the whole MFA feature
 * answered 500 in production. Nothing caught it because the Jest suite replaces
 * `otplib` with a manual mock (its ESM dependencies do not load under the CJS
 * runner) and no screen called these endpoints until now.
 */
const { generateSecret, verify, generateURI } = require('otplib');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { auditLog } = require('../utils/auditLogger');
const { createSession } = require('../utils/session');
const { serializeUser } = require('../utils/serializers');
const { isLockedOut, recordFailedAttempt, clearFailedAttempts } = require('../utils/loginAttempts');
const { notifyNewSignIn } = require('../utils/signInNotice');
const { track } = require('../utils/background');
const { blocksSignIn, MAINTENANCE_MESSAGE } = require('../utils/maintenance');
const { env } = require('../config/env');
const { JWT_VERIFY_OPTIONS } = require('../utils/jwtOptions');

const APP_NAME = 'Parentix';
const BACKUP_CODE_COUNT = 8;

/** A TOTP token is always six digits; a backup code is ten hex characters. */
const TOTP_PATTERN = /^\d{6}$/;

/**
 * Whether `token` is the current TOTP for `secret`. Never throws.
 *
 * otplib rejects a malformed token by throwing ("Token must be 6 digits, got
 * 10") rather than returning `{ valid: false }`. Calling it with whatever the
 * user typed therefore turned a mistyped code into a 500 — and, worse, made
 * backup codes unusable: `validate` tries TOTP first, so a ten-character backup
 * code threw before the code that redeems it could run. Backup codes exist for
 * the person who has already lost their authenticator, so that path failing is
 * the one that strands someone out of their account.
 */
const isValidTotp = async (secret, token) => {
  if (!secret || !TOTP_PATTERN.test(String(token || '').trim())) return false;
  try {
    const { valid } = await verify({ secret, token: String(token).trim() });
    return !!valid;
  } catch {
    return false;
  }
};

// POST /api/auth/mfa/setup  (authenticated, mfa not yet enabled)
// Generates a TOTP secret and returns the otpauth URI + QR code.
const setup = async (req, res, next) => {
  try {
    if (req.user.mfaEnabled) return res.status(400).json({ error: 'MFA already enabled' });

    const secret = generateSecret();
    /**
     * The label is what the authenticator app shows under "Parentix", so it has
     * to identify the account to a person holding the phone. `email` is null on
     * a phone-only account, and interpolating that put a literal "null" in the
     * QR — which is what someone would then see listed in Google Authenticator.
     * The number, then the name, then a constant: never nothing, and never null.
     */
    const label = req.user.email || req.user.phone || req.user.name || 'account';
    const otpauth = generateURI({ issuer: APP_NAME, label, secret });
    const qrCode = await QRCode.toDataURL(otpauth);

    // Persist the unconfirmed secret so enable() can verify it
    await req.user.update({ mfaSecret: secret });

    res.json({ secret, qrCode, otpauth });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/mfa/enable  { code }
// Verifies the first TOTP code and activates MFA, returning one-time backup codes.
const enable = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'TOTP code required' });
    if (req.user.mfaEnabled) return res.status(400).json({ error: 'MFA already enabled' });
    if (!req.user.mfaSecret) return res.status(400).json({ error: 'Call /mfa/setup first' });

    if (!(await isValidTotp(req.user.mfaSecret, code))) {
      return res.status(400).json({ error: 'Invalid TOTP code' });
    }

    const plainCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      crypto.randomBytes(5).toString('hex')
    );
    const hashedCodes = await Promise.all(plainCodes.map((c) => bcrypt.hash(c, 10)));

    await req.user.update({ mfaEnabled: true, mfaBackupCodes: JSON.stringify(hashedCodes) });
    auditLog(req, { userId: req.user.id, action: 'auth.mfa_enabled', entity: 'User', entityId: req.user.id });

    res.json({ backupCodes: plainCodes });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/mfa/disable  { password, code }
const disable = async (req, res, next) => {
  try {
    const { password, code } = req.body;

    /**
     * An account created through Google or a phone number has no password, so
     * there is nothing for `password` to be checked against — and demanding one
     * made this a door that only opens inward. `comparePassword` answers false
     * for a null hash rather than throwing, so every attempt came back "Invalid
     * password": such an account could switch MFA *on* from the settings screen
     * and then never switch it off, and the only way back out was to ask staff
     * to set a password on it.
     *
     * This is the same defect `authController.changePassword` was fixed for, and
     * it is resolved the same way: where there is no password, the live session
     * plus a current TOTP code is the proof. That is not a weakening — the code
     * still has to come from the authenticator being removed, so someone holding
     * only a borrowed session cannot use this.
     */
    const hasPassword = !!req.user.passwordHash;

    if (!code || (hasPassword && !password)) {
      return res.status(400).json({
        error: hasPassword ? 'Password and TOTP code required' : 'TOTP code required',
      });
    }
    if (!req.user.mfaEnabled) return res.status(400).json({ error: 'MFA is not enabled' });

    if (hasPassword && !(await req.user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    if (!(await isValidTotp(req.user.mfaSecret, code))) {
      return res.status(400).json({ error: 'Invalid TOTP code' });
    }

    await req.user.update({ mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });
    auditLog(req, { userId: req.user.id, action: 'auth.mfa_disabled', entity: 'User', entityId: req.user.id });

    res.json({ message: 'MFA disabled' });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/mfa/validate  { preAuthToken, code }
// Second login step: exchanges a short-lived pre-auth token + TOTP (or backup code) for a full JWT.
const validate = async (req, res, next) => {
  try {
    const { preAuthToken, code } = req.body;
    if (!preAuthToken || !code) return res.status(400).json({ error: 'preAuthToken and code required' });

    let decoded;
    try {
      decoded = jwt.verify(preAuthToken, env.auth.jwtSecret, JWT_VERIFY_OPTIONS);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired pre-auth token' });
    }

    if (!decoded.mfaRequired) return res.status(400).json({ error: 'Token is not a pre-auth token' });

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) return res.status(401).json({ error: 'Unauthorized' });

    /**
     * The second factor gets the same ceiling as the first.
     *
     * This endpoint counted nothing: a wrong code was audit-logged and thrown
     * away, so the account's own defence — the lockout every other credential
     * check in this codebase applies — simply did not exist on the step that is
     * supposed to be the strong one. Six digits is a million possibilities and
     * the pre-auth token is reusable for its full five minutes, so the only
     * thing standing in the way was a per-IP limiter that a second IP defeats.
     */
    if (isLockedOut(user)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_locked', entity: 'User', entityId: user.id });
      return res.status(423).json({ error: 'Too many incorrect codes. Try again later.' });
    }

    // Try TOTP first, then fall back to a backup code. `isValidTotp` returns
    // false rather than throwing for a backup-code-shaped value, which is what
    // lets the fallback below actually be reached.
    if (!(await isValidTotp(user.mfaSecret, code))) {
      // Try backup codes
      const stored = user.mfaBackupCodes ? JSON.parse(user.mfaBackupCodes) : [];
      let usedIndex = -1;
      for (let i = 0; i < stored.length; i++) {
        if (await bcrypt.compare(code, stored[i])) { usedIndex = i; break; }
      }
      if (usedIndex === -1) {
        const locked = await recordFailedAttempt(user);
        auditLog(req, { userId: user.id, action: 'auth.mfa_failed', entity: 'User', entityId: user.id });
        if (locked) {
          return res.status(423).json({ error: 'Too many incorrect codes. Try again later.' });
        }
        return res.status(401).json({ error: 'Invalid MFA code' });
      }
      // Burn the used backup code
      stored.splice(usedIndex, 1);
      await user.update({ mfaBackupCodes: JSON.stringify(stored) });
      auditLog(req, { userId: user.id, action: 'auth.mfa_backup_used', entity: 'User', entityId: user.id });
    }

    await clearFailedAttempts(user);

    /**
     * The fifth door into a session, and it needs the same maintenance gate as
     * the other four.
     *
     * `login` refuses before issuing the challenge, so an account with MFA on
     * never reaches here during maintenance by that route — but a pre-auth token
     * minted in the five minutes before the switch was flipped still would, and
     * this endpoint is what turns one into a full session. Checked here as well
     * so the gate does not depend on timing.
     */
    if (await blocksSignIn(user)) {
      auditLog(req, { userId: user.id, action: 'auth.login_blocked_maintenance', entity: 'User', entityId: user.id });
      return res.status(503).json({ error: MAINTENANCE_MESSAGE, maintenance: true });
    }

    const { token: fullToken, session } = await createSession(req, user.id);
    await user.update({ lastLoginAt: new Date() });
    auditLog(req, { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id });
    // Same unrecognised-device notice the single-factor paths send. Completing
    // MFA is still a sign-in, and a stolen second factor is exactly the case
    // where the owner most needs to hear about it.
    track(notifyNewSignIn(req, user, session.id));

    // Same shape as a non-MFA login so the client can finish signing in without
    // a second round trip to /auth/me.
    res.json({ token: fullToken, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
};

module.exports = { setup, enable, disable, validate };
