const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const bcrypt = require('bcryptjs');
const { normalizeEmail } = require('../utils/normalizeEmail');
const { normalizePhone } = require('../utils/normalizePhone');
const { hashCode } = require('../utils/otp');
const { encrypt, decrypt } = require('../utils/crypto');

/**
 * A one-time code is stored the way a password is: never as the thing itself.
 *
 * Put on the setters rather than left to the controllers for the same reason
 * `passwordHash` is hashed in a hook — there are four write paths between
 * registration, resend, profile email change and the phone flow, and the one
 * that forgets is the one that leaves six live digits in a backup. See
 * `utils/otp.js` for why this is a keyed HMAC rather than a plain digest.
 */
const codeColumn = (field) => ({
  type: DataTypes.STRING,
  set(value) {
    this.setDataValue(field, hashCode(value));
  },
});

const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  /**
   * Always stored lower-cased and trimmed.
   *
   * Postgres compares strings case-sensitively, so without this an account
   * registered as `Sam@Example.com` could never be signed into as
   * `sam@example.com`, and the unique index would happily accept both as two
   * separate people. Normalising in the setter covers every write path;
   * `User.findByEmail` is the matching read path.
   */
  /**
   * Null for an account created from a phone number, which has no address until
   * its owner adds one. Everything that sends mail has to tolerate that — see
   * `alertHelper`, which drops the email channel rather than addressing a null.
   */
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    set(value) {
      // '' would collide with the next email-less account on the unique index;
      // null is the absence of an address and repeats freely.
      this.setDataValue('email', normalizeEmail(value) || null);
    },
  },
  /**
   * E.164, stored through `normalizePhone` for the same reason the address is
   * lower-cased: one number written three ways must not become three accounts,
   * each able to prove ownership of the others' identity with an SMS code.
   */
  phone: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    set(value) {
      this.setDataValue('phone', normalizePhone(value) || null);
    },
  },
  phoneVerified: { type: DataTypes.BOOLEAN, defaultValue: false },
  phoneVerificationCode: codeColumn('phoneVerificationCode'),
  phoneVerificationExpires: { type: DataTypes.DATE },
  /**
   * Null for an account created through Sign in with Google, which has no
   * password and never will unless its owner sets one. `comparePassword` treats
   * that as "no password matches" rather than handing null to bcrypt.
   */
  passwordHash: { type: DataTypes.STRING, allowNull: true },
  /**
   * The `sub` claim from Google's ID token. Stable for the life of the Google
   * account and — unlike the email address — not something its owner can change,
   * so once an account is linked this is what it is looked up by.
   */
  googleId: { type: DataTypes.STRING, unique: true },
  role: { type: DataTypes.STRING, defaultValue: 'parent' },
  plan: { type: DataTypes.STRING, defaultValue: 'free' },
  trialEndsAt: { type: DataTypes.DATE },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  mfaEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  /**
   * The TOTP seed, encrypted at rest — see the hooks at the foot of this file.
   *
   * It sat here in plain base32, which made it the last credential on the
   * platform that a database read handed over whole. Everything beside it had
   * already been dealt with: passwords are bcrypt, one-time codes are a keyed
   * HMAC, push tokens are AES-GCM, browsing URLs are AES-GCM. A TOTP seed is
   * worse than any of them, because it does not expire and it does not change —
   * whoever reads it can mint a valid second factor for that account for as long
   * as MFA stays on, and nothing the account holder can see would say so.
   *
   * That also inverts what MFA is for here. Staff accounts are the ones told to
   * turn it on, so the accounts whose seeds were readable were exactly the
   * accounts that open the customer directory.
   *
   * `mfaBackupCodes` needs no such treatment: those are already bcrypt hashes
   * (see mfaController.enable), which is the right storage for a secret that is
   * only ever compared.
   */
  mfaSecret: { type: DataTypes.STRING },
  mfaBackupCodes: { type: DataTypes.TEXT },
  emailVerified: { type: DataTypes.BOOLEAN, defaultValue: false },
  emailVerificationCode: codeColumn('emailVerificationCode'),
  emailVerificationExpires: { type: DataTypes.DATE },
  /**
   * The forgotten-password code, and the ticket it buys.
   *
   * Two pairs rather than one, because they are two different secrets at two
   * different moments: `passwordResetCode` is the six digits that go to the
   * address, and `passwordResetToken` is what `verify-reset-code` mints once
   * those digits come back — the short-lived proof the "choose a new password"
   * screen presents. Folding them into one column would mean either emailing
   * the ticket (which is the link this flow replaced) or keeping the code alive
   * after it has been spent.
   */
  passwordResetCode: codeColumn('passwordResetCode'),
  passwordResetCodeExpires: { type: DataTypes.DATE },
  /**
   * A keyed digest of the ticket, never the ticket. Hashed at the two call sites
   * rather than in a setter here, because the ticket is already 64 hex
   * characters and `hashCode`'s already-hashed passthrough would mistake it for
   * its own output and store it verbatim — see `otp.hashTicket`.
   */
  passwordResetToken: { type: DataTypes.STRING },
  passwordResetExpires: { type: DataTypes.DATE },
  /**
   * Per-purpose counters for the code flows: how many have been sent, when the
   * last one went, and how many wrong guesses the live one has taken. TEXT
   * holding JSON — see `utils/otp.js` for the shape and for why it is not a
   * JSON column.
   */
  otpState: { type: DataTypes.TEXT, defaultValue: '{}' },
  stripeCustomerId: { type: DataTypes.STRING },
  stripeSubscriptionId: { type: DataTypes.STRING },
  subscriptionStatus: { type: DataTypes.STRING, defaultValue: 'trial' },
  notificationPrefs: { type: DataTypes.TEXT, defaultValue: '{}' },
  permissions: { type: DataTypes.JSON, defaultValue: [] },
  lastLoginAt: { type: DataTypes.DATE },
  failedLoginAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  lockedUntil: { type: DataTypes.DATE },
}, { underscored: true });

/**
 * The read counterpart to the `email` setter — the only supported way to look an
 * account up by address. A bare `where: { email }` would miss rows whenever the
 * caller's casing differs from what was stored.
 */
User.findByEmail = function (email, options = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return Promise.resolve(null);
  return User.findOne({ ...options, where: { ...options.where, email: normalized } });
};

/**
 * The read counterpart to the `phone` setter, and the only supported way to look
 * an account up by number. A bare `where: { phone }` would miss every row whose
 * stored form differs in punctuation from what the caller typed.
 */
User.findByPhone = function (phone, options = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) return Promise.resolve(null);
  return User.findOne({ ...options, where: { ...options.where, phone: normalized } });
};

User.prototype.comparePassword = async function (plain) {
  // A Google-only account has no hash. bcrypt.compare against null resolves
  // false on some versions and throws on others, and a throw here would surface
  // as a 500 on the login route — telling an attacker that the address exists
  // and is Google-linked, which the 401 deliberately does not.
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

User.beforeSave(async (user) => {
  if (user.changed('passwordHash') && user.passwordHash) {
    user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
  }
});

/* ── The TOTP seed, encrypted at rest ─────────────────────────────────────────
 *
 * Hooks rather than a getter/setter pair, mirroring `models/PushToken.js`, and
 * for the same reason: a getter that decrypted on every read would also run
 * against rows Sequelize builds with `raw: true` and against attribute-limited
 * selects that never fetched the column, and the failure would be a throw deep
 * inside a query rather than anything a caller could see.
 *
 * `decrypt` returns a value that carries no `:` unchanged, so a row written
 * before this existed still reads back as its plain base32 seed and keeps
 * working. Migration 0017 converts them; this is what keeps the two orderings
 * safe in between.
 */
const ENCRYPTED = Symbol('encryptedMfaSecret');

User.beforeSave((user) => {
  if (!user.mfaSecret) return;
  /**
   * The double-encryption trap PushToken documents, which is not hypothetical:
   * `afterFind` assigns the decrypted seed, which marks the attribute changed,
   * so an unrelated `user.update({ lastLoginAt })` on a loaded instance saves
   * `mfaSecret` too. Encrypting unconditionally is correct there — plaintext in,
   * ciphertext out — but a second pass over the same instance would encrypt the
   * ciphertext, and the seed would then be unrecoverable and every subsequent
   * code wrong, with MFA the only way into the account.
   */
  if (user[ENCRYPTED] === user.mfaSecret) return;
  user.mfaSecret = encrypt(user.mfaSecret);
  user[ENCRYPTED] = user.mfaSecret;
});

User.afterFind((results) => {
  if (!results) return;
  const rows = Array.isArray(results) ? results : [results];
  for (const row of rows) {
    // `undefined` means the column was not selected — most reads of this table
    // ask for a handful of attributes and must not be disturbed.
    if (!row || typeof row.getDataValue !== 'function' || !row.mfaSecret) continue;
    try {
      row.mfaSecret = decrypt(row.mfaSecret);
    } catch {
      /**
       * A seed this deployment's key cannot open — a restored dump from another
       * environment, or a key that was rotated without re-wrapping. Left as it
       * is rather than thrown: this hook runs on `authenticate`'s user lookup,
       * so a throw would take down every authenticated request on the service
       * over one unreadable row. `isValidTotp` answers false for a seed that
       * does not verify, which fails the sign-in it should fail and leaves the
       * rest of the platform up.
       */
    }
    row[ENCRYPTED] = undefined;
  }
});

module.exports = User;
