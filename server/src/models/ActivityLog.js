const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const { encrypt, decrypt } = require('../utils/crypto');

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
}, { underscored: true });

// Encrypt url before writing
const encryptUrl = (log) => {
  if (log.url) log.url = encrypt(log.url);
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
