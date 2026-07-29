const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Transaction = sequelize.define('Transaction', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  stripeEventId: { type: DataTypes.STRING, unique: true },
  type: { type: DataTypes.STRING, allowNull: false },
  amount: { type: DataTypes.INTEGER },
  currency: { type: DataTypes.STRING, defaultValue: 'usd' },
  plan: { type: DataTypes.STRING },
  status: { type: DataTypes.STRING, allowNull: false },
  metadata: { type: DataTypes.JSON },
}, { underscored: true, updatedAt: false });

module.exports = Transaction;
