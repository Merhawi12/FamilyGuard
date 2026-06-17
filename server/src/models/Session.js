const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Session = sequelize.define('Session', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  ipAddress: { type: DataTypes.STRING },
  userAgent: { type: DataTypes.STRING },
  lastActiveAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  revoked: { type: DataTypes.BOOLEAN, defaultValue: false },
  revokedAt: { type: DataTypes.DATE },
}, { underscored: true });

module.exports = Session;
