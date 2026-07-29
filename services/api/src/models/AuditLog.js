const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const AuditLog = sequelize.define('AuditLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID },
  action: { type: DataTypes.STRING, allowNull: false },
  entity: { type: DataTypes.STRING },
  entityId: { type: DataTypes.UUID },
  metadata: { type: DataTypes.JSON },
  ipAddress: { type: DataTypes.STRING },
  userAgent: { type: DataTypes.STRING },
}, { underscored: true, updatedAt: false });

module.exports = AuditLog;
