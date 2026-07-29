const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Contact = sequelize.define('Contact', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  parentId: { type: DataTypes.UUID, allowNull: false },
  childId: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  phoneNumber: { type: DataTypes.STRING },
  email: { type: DataTypes.STRING },
  relationship: { type: DataTypes.STRING, defaultValue: 'other' },
  isApproved: { type: DataTypes.BOOLEAN, defaultValue: true },
  notes: { type: DataTypes.TEXT },
}, { underscored: true });

module.exports = Contact;
