const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const SystemSetting = sequelize.define('SystemSetting', {
  key: { type: DataTypes.STRING, primaryKey: true },
  value: { type: DataTypes.JSON },
}, { underscored: true });

module.exports = SystemSetting;
