const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ActivityLog = sequelize.define('ActivityLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  deviceId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID, allowNull: false },
  appName: { type: DataTypes.STRING },
  appPackage: { type: DataTypes.STRING },
  category: {
    type: DataTypes.ENUM('social_media', 'gaming', 'education', 'entertainment', 'browsing', 'other'),
    defaultValue: 'other',
  },
  startTime: { type: DataTypes.DATE, allowNull: false },
  endTime: { type: DataTypes.DATE },
  durationMinutes: { type: DataTypes.FLOAT, defaultValue: 0 },
  url: { type: DataTypes.STRING },
}, { underscored: true });

module.exports = ActivityLog;
