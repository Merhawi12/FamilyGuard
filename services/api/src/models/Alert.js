const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Alert = sequelize.define('Alert', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  parentId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID },
  deviceId: { type: DataTypes.UUID },
  type: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  severity: { type: DataTypes.STRING, defaultValue: 'medium' },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
  metadata: { type: DataTypes.TEXT, defaultValue: '{}' },
}, {
  underscored: true,
  indexes: [
    { fields: ['parent_id'] },
    { fields: ['child_id'] },
  ],
});

module.exports = Alert;
