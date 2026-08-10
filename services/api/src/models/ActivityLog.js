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

// Decrypt url after reading
const decryptUrl = (log) => {
  if (log.url) log.url = decrypt(log.url);
};

ActivityLog.afterFind((results) => {
  if (!results) return;
  const logs = Array.isArray(results) ? results : [results];
  logs.forEach(decryptUrl);
});

module.exports = ActivityLog;
