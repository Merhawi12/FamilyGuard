const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Notification = sequelize.define('Notification', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  type: { type: DataTypes.STRING, defaultValue: 'info' },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
  createdBy: { type: DataTypes.UUID },
}, {
  underscored: true,
  updatedAt: false,
  // Read as "this user's notifications, newest first" by the family app's bell,
  // which polls. The ordering column is in the index so the filter and the sort
  // are one operation rather than a scan and a sort.
  indexes: [{ fields: ['user_id', 'created_at'] }],
});

module.exports = Notification;
