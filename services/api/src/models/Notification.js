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
  /**
   * Where reading this notification should take you, as an in-app path.
   *
   * Nullable, and null is what every announcement has: a maintenance notice is
   * about nothing in particular and the bell is where it ends. It is the
   * platform's *automatic* notices that have somewhere to go — a payment notice
   * that cannot take a finance operator to the payment is a dead end, and so is
   * a receipt that cannot take a parent to their plan.
   *
   * Deliberately a path and not a URL. It is rendered by whichever app the
   * reader is in, and a stored absolute URL would be this deployment's host
   * frozen into a database row — wrong the moment the console moves, and an open
   * redirect if anything ever writes one from user input.
   */
  link: { type: DataTypes.STRING },
}, {
  underscored: true,
  updatedAt: false,
  // Read as "this user's notifications, newest first" by the family app's bell,
  // which polls. The ordering column is in the index so the filter and the sort
  // are one operation rather than a scan and a sort.
  indexes: [{ fields: ['user_id', 'created_at'] }],
});

module.exports = Notification;
