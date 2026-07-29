const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const AppRule = sequelize.define('AppRule', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  appName: { type: DataTypes.STRING, allowNull: false },
  appPackage: { type: DataTypes.STRING },
  action: { type: DataTypes.STRING, defaultValue: 'block' },
  dailyLimitMinutes: { type: DataTypes.INTEGER },
  category: { type: DataTypes.STRING },
  iconUrl: { type: DataTypes.STRING },
}, { underscored: true });

module.exports = AppRule;
