const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Device = sequelize.define('Device', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.STRING, defaultValue: 'android' },
  osVersion: { type: DataTypes.STRING },
  linkingCode: { type: DataTypes.STRING, unique: true },
  linkingCodeExpiry: { type: DataTypes.DATE },
  isLinked: { type: DataTypes.BOOLEAN, defaultValue: false },
  lastSeen: { type: DataTypes.DATE },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  pushToken: { type: DataTypes.STRING },
}, {
  underscored: true,
  // Every device read is "the active devices of these children" — the parent's
  // device list, the plan's allowance count, and the rules the child app pulls.
  indexes: [{ fields: ['child_id', 'is_active'] }],
});

module.exports = Device;
