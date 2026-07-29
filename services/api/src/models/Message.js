const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  parentId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID, allowNull: false },
  senderId: { type: DataTypes.UUID, allowNull: false },
  senderRole: { type: DataTypes.STRING, allowNull: false }, // parent | child
  text: { type: DataTypes.TEXT, allowNull: false },
  // normal | emergency | check_in
  messageType: { type: DataTypes.STRING, defaultValue: 'normal' },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
}, { underscored: true, updatedAt: false });

module.exports = Message;
