const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ScreenTimeRule = sequelize.define('ScreenTimeRule', {
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
  dailyLimitMinutes: { type: DataTypes.INTEGER, defaultValue: 120 },
  /**
   * Allowed hours per day. An enabled day restricts use to `start`–`end`; a
   * disabled one places no restriction.
   *
   * Every day starts disabled, with sensible times pre-filled for when the
   * parent does switch one on. This matters because simply opening the Screen
   * Time page creates the rule: defaulting the days to enabled would lock every
   * child outside 08:00–20:00 the moment their parent looked at the screen,
   * without anyone having chosen it.
   */
  schedule: {
    type: DataTypes.TEXT,
    defaultValue: JSON.stringify({
      monday: { enabled: false, start: '08:00', end: '20:00' },
      tuesday: { enabled: false, start: '08:00', end: '20:00' },
      wednesday: { enabled: false, start: '08:00', end: '20:00' },
      thursday: { enabled: false, start: '08:00', end: '20:00' },
      friday: { enabled: false, start: '08:00', end: '20:00' },
      saturday: { enabled: false, start: '10:00', end: '22:00' },
      sunday: { enabled: false, start: '10:00', end: '22:00' },
    }),
    get() { try { return JSON.parse(this.getDataValue('schedule')); } catch { return {}; } },
    set(val) { this.setDataValue('schedule', JSON.stringify(val)); },
  },
  bedtimeEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  bedtimeStart: { type: DataTypes.STRING, defaultValue: '21:00' },
  bedtimeEnd: { type: DataTypes.STRING, defaultValue: '07:00' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
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

module.exports = ScreenTimeRule;
