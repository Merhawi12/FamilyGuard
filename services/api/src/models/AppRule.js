const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const AppRule = sequelize.define('AppRule', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  /**
   * The one device this rule is for, or NULL for every device the child owns.
   *
   * NULL is what every existing row means and what the dashboard writes unless
   * the parent narrows it, so this column changes nothing until it is used. A
   * row naming a device overrides the child-wide row it collides with, for that
   * device only — see utils/deviceScope.js, which is the single place that
   * decides what "collides" means for each rule type.
   *
   * The scoping is resolved on the server, in the sync the device already
   * makes, so a phone never learns that a rule for its sibling exists.
   */
  deviceId: { type: DataTypes.UUID, allowNull: true },
  appName: { type: DataTypes.STRING, allowNull: false },
  appPackage: { type: DataTypes.STRING },
  action: { type: DataTypes.STRING, defaultValue: 'block' },
  dailyLimitMinutes: { type: DataTypes.INTEGER },
  category: { type: DataTypes.STRING },
  iconUrl: { type: DataTypes.STRING },
}, {
  underscored: true,
  indexes: [
    { fields: ['child_id'] },
    // The index over `device_id` is deliberately NOT declared here — it lives in
    // migration 0016 alone, for the same reason ActivityLog's `url_hash` index
    // lives only in 0007.
    //
    // `sync()` runs before the migrations and tries to create every index a
    // model declares, but it will not add a column to a table that already
    // exists. On any database created before `device_id` existed — which is
    // every deployed one — declaring it here makes sync fail with
    // "column device_id does not exist" and the API never finishes booting.
    // A fresh database hides it completely, because there the table is created
    // with the column already present, which is why every test suite passed and
    // production did not start.
  ],
});

module.exports = AppRule;
