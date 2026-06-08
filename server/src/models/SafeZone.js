const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// A safe zone can be scoped to a specific child (childId set) or apply to all children (childId null).
const SafeZone = sequelize.define('SafeZone', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  parentId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID },
  name: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.STRING, defaultValue: 'custom' }, // home | school | sports | custom
  latitude: { type: DataTypes.FLOAT, allowNull: false },
  longitude: { type: DataTypes.FLOAT, allowNull: false },
  radiusMeters: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 200 },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  notifyOnEnter: { type: DataTypes.BOOLEAN, defaultValue: true },
  notifyOnLeave: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { underscored: true });

module.exports = SafeZone;
