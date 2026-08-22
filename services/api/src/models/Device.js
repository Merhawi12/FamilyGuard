const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Device = sequelize.define('Device', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.STRING, defaultValue: 'android' },
  osVersion: { type: DataTypes.STRING },
  linkingCode: { type: DataTypes.STRING, unique: true },
  linkingCodeExpiry: { type: DataTypes.DATE },
  isLinked: { type: DataTypes.BOOLEAN, defaultValue: false },
  lastSeen: { type: DataTypes.DATE },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  /**
   * When the parent paused this one device. NULL means it is not paused.
   *
   * Deliberately not the same flag as `isActive`, and deliberately a timestamp.
   *
   * `isActive: false` means *removed*: the row is a tombstone, the token is dead
   * for ever, and the child app is told `device_unlinked` so it forgets its
   * credentials and returns to the linking screen. There is no way back from it
   * except a fresh code. A block is the opposite in every respect — reversible
   * in one tap, and the device must stay authenticated so that the unblock can
   * reach it and so the parent keeps seeing where the phone is while it is
   * locked. Overloading `isActive` would have made "pause the tablet for an
   * hour" indistinguishable from "throw the tablet away".
   *
   * A timestamp rather than a boolean because the lock screen says *when* it
   * happened, and because "blocked since" is the question a parent asks next.
   */
  blockedAt: { type: DataTypes.DATE, allowNull: true },
  pushToken: { type: DataTypes.STRING },
}, {
  underscored: true,
  // Every device read is "the active devices of these children" — the parent's
  // device list, the plan's allowance count, and the rules the child app pulls.
  indexes: [{ fields: ['child_id', 'is_active'] }],
});

module.exports = Device;
