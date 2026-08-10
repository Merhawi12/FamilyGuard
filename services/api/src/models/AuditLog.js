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
}, {
  underscored: true,
  updatedAt: false,
  /**
   * This is the busiest table on the platform — 57 call sites write to it, every
   * admin action and auth event among them — and it had no index at all. Every
   * read orders by `created_at` (System Logs, the Overview alert panel), filters
   * the actor by `user_id`, and derives level and service with a prefix match on
   * `action`, so all three are covered.
   */
  indexes: [
    { fields: ['created_at'] },
    { fields: ['user_id'] },
    { fields: ['action'] },
  ],
});

module.exports = AuditLog;
