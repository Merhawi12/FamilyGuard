const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ScreenTimeRule = sequelize.define('ScreenTimeRule', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
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
}, { underscored: true });

module.exports = ScreenTimeRule;
