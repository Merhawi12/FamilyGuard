const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Child = sequelize.define('Child', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  parentId: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  age: { type: DataTypes.INTEGER },
  // Preset avatar name (e.g. 'default'); `avatarUrl` overrides it when the
  // parent has uploaded a photo to Cloud Storage.
  avatar: { type: DataTypes.STRING, defaultValue: 'default' },
  avatarUrl: { type: DataTypes.STRING },
  pin: { type: DataTypes.STRING },
  dailyLimitMinutes: { type: DataTypes.INTEGER, defaultValue: 120 },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { underscored: true });

module.exports = Child;
