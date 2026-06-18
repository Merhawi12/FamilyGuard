const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.STRING, defaultValue: 'parent' },
  plan: { type: DataTypes.STRING, defaultValue: 'free' },
  trialEndsAt: { type: DataTypes.DATE },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  mfaEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  mfaSecret: { type: DataTypes.STRING },
  mfaBackupCodes: { type: DataTypes.TEXT },
  emailVerified: { type: DataTypes.BOOLEAN, defaultValue: false },
  emailVerificationCode: { type: DataTypes.STRING },
  emailVerificationExpires: { type: DataTypes.DATE },
  stripeCustomerId: { type: DataTypes.STRING },
  stripeSubscriptionId: { type: DataTypes.STRING },
  subscriptionStatus: { type: DataTypes.STRING, defaultValue: 'trial' },
  notificationPrefs: { type: DataTypes.TEXT, defaultValue: '{}' },
  permissions: { type: DataTypes.JSON, defaultValue: [] },
  lastLoginAt: { type: DataTypes.DATE },
  failedLoginAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  lockedUntil: { type: DataTypes.DATE },
}, { underscored: true });

User.prototype.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

User.beforeCreate(async (user) => {
  user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
});

module.exports = User;
