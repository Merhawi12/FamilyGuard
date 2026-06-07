const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Device = sequelize.define('Device', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.ENUM('android', 'ios', 'windows', 'mac', 'other'), defaultValue: 'android' },
  osVersion: { type: DataTypes.STRING },
  linkingCode: { type: DataTypes.STRING, unique: true },
  linkingCodeExpiry: { type: DataTypes.DATE },
  isLinked: { type: DataTypes.BOOLEAN, defaultValue: false },
  lastSeen: { type: DataTypes.DATE },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  pushToken: { type: DataTypes.STRING },
}, { underscored: true });

module.exports = Device;
