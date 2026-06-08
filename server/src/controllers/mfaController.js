const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { auditLog } = require('../utils/auditLogger');

const APP_NAME = 'FamilyGuard';
const BACKUP_CODE_COUNT = 8;

// POST /api/auth/mfa/setup  (authenticated, mfa not yet enabled)
// Generates a TOTP secret and returns the otpauth URI + QR code.
const setup = async (req, res) => {
  try {
    if (req.user.mfaEnabled) return res.status(400).json({ error: 'MFA already enabled' });

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user.email, APP_NAME, secret);
    const qrCode = await QRCode.toDataURL(otpauth);

    // Persist the unconfirmed secret so enable() can verify it
    await req.user.update({ mfaSecret: secret });

    res.json({ secret, qrCode, otpauth });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/auth/mfa/enable  { code }
// Verifies the first TOTP code and activates MFA, returning one-time backup codes.
const enable = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'TOTP code required' });
    if (req.user.mfaEnabled) return res.status(400).json({ error: 'MFA already enabled' });
    if (!req.user.mfaSecret) return res.status(400).json({ error: 'Call /mfa/setup first' });

    const valid = authenticator.verify({ token: code, secret: req.user.mfaSecret });
    if (!valid) return res.status(400).json({ error: 'Invalid TOTP code' });

    const plainCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      crypto.randomBytes(5).toString('hex')
    );
    const hashedCodes = await Promise.all(plainCodes.map((c) => bcrypt.hash(c, 10)));

    await req.user.update({ mfaEnabled: true, mfaBackupCodes: JSON.stringify(hashedCodes) });
    auditLog(req, { userId: req.user.id, action: 'auth.mfa_enabled', entity: 'User', entityId: req.user.id });

    res.json({ backupCodes: plainCodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/auth/mfa/disable  { password, code }
const disable = async (req, res) => {
  try {
    const { password, code } = req.body;
    if (!password || !code) return res.status(400).json({ error: 'Password and TOTP code required' });
    if (!req.user.mfaEnabled) return res.status(400).json({ error: 'MFA is not enabled' });

    const passwordOk = await req.user.comparePassword(password);
    if (!passwordOk) return res.status(401).json({ error: 'Invalid password' });

    const valid = authenticator.verify({ token: code, secret: req.user.mfaSecret });
    if (!valid) return res.status(400).json({ error: 'Invalid TOTP code' });

    await req.user.update({ mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });
    auditLog(req, { userId: req.user.id, action: 'auth.mfa_disabled', entity: 'User', entityId: req.user.id });

    res.json({ message: 'MFA disabled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/auth/mfa/validate  { preAuthToken, code }
// Second login step: exchanges a short-lived pre-auth token + TOTP (or backup code) for a full JWT.
const validate = async (req, res) => {
  try {
    const { preAuthToken, code } = req.body;
    if (!preAuthToken || !code) return res.status(400).json({ error: 'preAuthToken and code required' });

    let decoded;
    try {
      decoded = jwt.verify(preAuthToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired pre-auth token' });
    }

    if (!decoded.mfaRequired) return res.status(400).json({ error: 'Token is not a pre-auth token' });

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) return res.status(401).json({ error: 'Unauthorized' });

    // Try TOTP first
    const totpValid = authenticator.verify({ token: code, secret: user.mfaSecret });
    if (!totpValid) {
      // Try backup codes
      const stored = user.mfaBackupCodes ? JSON.parse(user.mfaBackupCodes) : [];
      let usedIndex = -1;
      for (let i = 0; i < stored.length; i++) {
        if (await bcrypt.compare(code, stored[i])) { usedIndex = i; break; }
      }
      if (usedIndex === -1) {
        auditLog(req, { userId: user.id, action: 'auth.mfa_failed', entity: 'User', entityId: user.id });
        return res.status(401).json({ error: 'Invalid MFA code' });
      }
      // Burn the used backup code
      stored.splice(usedIndex, 1);
      await user.update({ mfaBackupCodes: JSON.stringify(stored) });
      auditLog(req, { userId: user.id, action: 'auth.mfa_backup_used', entity: 'User', entityId: user.id });
    }

    const fullToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    auditLog(req, { userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id });

    res.json({ token: fullToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { setup, enable, disable, validate };
