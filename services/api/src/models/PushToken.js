const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { encrypt, decrypt, blindIndex } = require('../utils/crypto');

/**
 * One push destination: a parent's browser, or a child's device.
 *
 * A token is a bearer credential — anyone holding it can send a notification to
 * that device — so it is stored encrypted like any other secret, with a blind
 * index for the lookups that need it: recognising a token the browser or device
 * re-registers, and revoking one the push service has rejected.
 *
 * Exactly one of `userId` and `deviceId` is set. Parents subscribe per browser
 * and so have several rows; a child device has one per install.
 */
const PushToken = sequelize.define('PushToken', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

  userId: { type: DataTypes.UUID },
  deviceId: { type: DataTypes.UUID },

  /** 'web' — a Web Push subscription; 'expo' — an Expo push token. */
  platform: { type: DataTypes.STRING, allowNull: false },

  /** Encrypted. For 'web' this is the serialized subscription object. */
  token: { type: DataTypes.TEXT, allowNull: false },
  tokenHash: { type: DataTypes.STRING, allowNull: false },

  /** A human label for the settings screen, e.g. "Chrome on Windows". */
  label: { type: DataTypes.STRING },

  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  /**
   * Consecutive send failures. A push service can fail transiently, so a token
   * is only retired once it has failed repeatedly or been rejected outright.
   */
  failureCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  lastError: { type: DataTypes.STRING },
  lastSuccessAt: { type: DataTypes.DATE },
}, {
  underscored: true,
  indexes: [
    { fields: ['user_id', 'is_active'] },
    { fields: ['device_id', 'is_active'] },
    { fields: ['token_hash'] },
  ],
});

/**
 * Marks the ciphertext this hook produced, so a second pass over the same
 * instance recognises its own work and leaves it alone.
 *
 * A symbol rather than a field: it is bookkeeping for one save, not an attribute,
 * and must never reach the table or a JSON response.
 */
const ENCRYPTED = Symbol('encryptedToken');

// Derive the blind index from the plaintext, then encrypt. A row read back has
// already been decrypted by the afterFind hook, so an update that only touches
// the failure counters still re-encrypts the same token correctly.
//
// This has to run on `beforeValidate`, not `beforeCreate`: Sequelize validates
// before the create hook, so a hash filled in there arrives too late for the
// `allowNull: false` check and every insert fails.
const encryptToken = (row) => {
  if (!row.token) return;

  /**
   * `beforeValidate` does not fire exactly once per save. An `instance.update()`
   * that names `token` among its values validates twice, and the second pass
   * used to encrypt the ciphertext the first one had just produced.
   *
   * The stored value then needed decrypting twice, so `afterFind` returned
   * ciphertext and every send handed the push service a block of base64 instead
   * of a token. Web Push fails to parse that, and this codebase — correctly —
   * treats an unparseable subscription as permanent and retires it.
   *
   * The path that triggers it is the ordinary one, not an edge case:
   * `registerToken` updates the existing row whenever a token is re-registered,
   * and a browser re-registers on every sign-in. A parent therefore lost
   * notifications for good the second time they signed in, having done nothing
   * unusual, with the row marked "stopped working" and no way to tell why.
   */
  if (row[ENCRYPTED] === row.token) return;

  row.tokenHash = blindIndex(row.token);
  row.token = encrypt(row.token);
  row[ENCRYPTED] = row.token;
};

PushToken.beforeValidate(encryptToken);

PushToken.afterFind((results) => {
  if (!results) return;
  const rows = Array.isArray(results) ? results : [results];
  rows.forEach((row) => {
    if (!row?.token) return;
    row.token = decrypt(row.token);
    // The instance now holds plaintext, so the guard above must not mistake it
    // for something already encrypted when this row is next saved.
    row[ENCRYPTED] = undefined;
  });
});

module.exports = PushToken;
