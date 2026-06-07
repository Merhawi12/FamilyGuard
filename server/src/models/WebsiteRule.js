const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const WebsiteRule = sequelize.define('WebsiteRule', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  url: { type: DataTypes.STRING },
  category: {
    type: DataTypes.ENUM('adult', 'gambling', 'gaming', 'social_media', 'violence', 'custom'),
    defaultValue: 'custom',
  },
  action: { type: DataTypes.ENUM('block', 'allow'), defaultValue: 'block' },
}, { underscored: true });

module.exports = WebsiteRule;
