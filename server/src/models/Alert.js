const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Alert = sequelize.define('Alert', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  parentId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID },
  deviceId: { type: DataTypes.UUID },
  type: {
    type: DataTypes.ENUM(
      'blocked_app_attempt',
      'screen_time_exceeded',
      'suspicious_activity',
      'device_offline',
      'bedtime_violation'
    ),
    allowNull: false,
  },
  message: { type: DataTypes.TEXT, allowNull: false },
  severity: { type: DataTypes.ENUM('low', 'medium', 'high'), defaultValue: 'medium' },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
  metadata: { type: DataTypes.JSONB, defaultValue: {} },
}, { underscored: true });

module.exports = Alert;
