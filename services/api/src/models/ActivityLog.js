const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { encrypt, decrypt, blindIndex } = require('../utils/crypto');

const ActivityLog = sequelize.define('ActivityLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  deviceId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID, allowNull: false },
  appName: { type: DataTypes.STRING },
  appPackage: { type: DataTypes.STRING },
  category: { type: DataTypes.STRING, defaultValue: 'other' },
  startTime: { type: DataTypes.DATE, allowNull: false },
  endTime: { type: DataTypes.DATE },
  durationMinutes: { type: DataTypes.FLOAT, defaultValue: 0 },
  url: { type: DataTypes.STRING },
  // Deterministic index over `url`, which is encrypted with a random IV and so
  // cannot be matched on directly. Written by the hook below, never by callers.
  urlHash: { type: DataTypes.STRING },
  // How many times this domain was resolved within one visit window.
  visitCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  // The DNS proxy answered NXDOMAIN for this name: a filter rule stopped it.
  // Sticky across a merge — a domain resolved twice in one window, once blocked,
  // is a blocked attempt, which is what the reporter on the device decides too.
  blocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  underscored: true,
  indexes: [
    { fields: ['device_id'] },
    { fields: ['child_id', 'start_time'] },
    // The index over `url_hash` is deliberately NOT declared here — it lives in
    // migration 0007 alone.
    //
    // `sync()` runs before the migrations and tries to create every index a
    // model declares, but it will not add a column to a table that already
    // exists. On any database created before `url_hash` existed, declaring the
    // index here makes sync fail with "no such column: url_hash" and the API
    // never finishes booting. A fresh database hides it completely, because
    // there the table is created with the column already present.
  ],
});

// Encrypt url before writing, and derive its blind index from the plaintext
// first — after encryption there is nothing stable left to index.
const encryptUrl = (log) => {
  if (log.url) {
    log.urlHash = blindIndex(log.url);
    log.url = encrypt(log.url);
  }
};

ActivityLog.beforeCreate(encryptUrl);
ActivityLog.beforeUpdate(encryptUrl);

/**
 * Decrypt `url` after reading — and never throw doing it.
 *
 * The guard is the whole of this function, and it is not defensive padding.
 * `decrypt` returns a value carrying no `:` unchanged, which is what lets a row
 * written before encryption existed read back as itself — but **a url always
 * carries a `:`**, in `https://`. So that escape hatch, which covers every other
 * encrypted column on the platform, covers nothing here: any row this
 * deployment's key cannot open reaches `Buffer.from(undefined)` and throws.
 *
 * A throw here is not one bad row, it is the endpoint. This hook runs on every
 * read of `activity_logs` — the activity log, web history, the daily and weekly
 * reports, the safety analyser — and Sequelize runs it over the whole result
 * set, so one unreadable row 500s the entire response and every retry of it.
 * The ways a row gets there are all real and none of them are the child app:
 * a restored dump from another environment, a `FIELD_ENCRYPTION_KEY` rotated
 * without re-wrapping, or any write path that skips the hooks (a bare
 * `bulkCreate` without `individualHooks`, a manual insert).
 *
 * Left exactly as stored rather than nulled: the caller sees a value it cannot
 * make sense of instead of being told confidently that the child visited
 * nothing. `models/User.js` guards its `mfaSecret` hook for the same reason and
 * says so — this table is the more exposed of the two and had no guard at all.
 */
const decryptUrl = (log) => {
  if (!log.url) return;
  try {
    log.url = decrypt(log.url);
  } catch {
    /* unreadable with this key — see above */
  }
};

ActivityLog.afterFind((results) => {
  if (!results) return;
  const logs = Array.isArray(results) ? results : [results];
  logs.forEach(decryptUrl);
});

module.exports = ActivityLog;
