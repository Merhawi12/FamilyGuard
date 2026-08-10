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
}, {
  underscored: true,
  updatedAt: false,
  // The billing screen reads one customer's history newest-first, and derives
  // MRR and the revenue trend from billed rows over a window.
  indexes: [
    { fields: ['user_id', 'created_at'] },
    { fields: ['status', 'created_at'] },
  ],
});

module.exports = Transaction;
