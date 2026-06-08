const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Location = sequelize.define('Location', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  deviceId: { type: DataTypes.UUID, allowNull: false },
  latitude: { type: DataTypes.FLOAT, allowNull: false },
  longitude: { type: DataTypes.FLOAT, allowNull: false },
  accuracy: { type: DataTypes.FLOAT },
  speed: { type: DataTypes.FLOAT },
  heading: { type: DataTypes.FLOAT },
  address: { type: DataTypes.STRING },
  recordedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { underscored: true, updatedAt: false });

module.exports = Location;
