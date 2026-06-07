const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM('parent', 'admin'), defaultValue: 'parent' },
  plan: { type: DataTypes.ENUM('free', 'premium', 'family', 'school'), defaultValue: 'free' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { underscored: true });

User.prototype.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

User.beforeCreate(async (user) => {
  user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
});

module.exports = User;
