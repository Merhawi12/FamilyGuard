const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ScreenTimeRule = sequelize.define('ScreenTimeRule', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },
  dailyLimitMinutes: { type: DataTypes.INTEGER, defaultValue: 120 },
  schedule: {
    type: DataTypes.TEXT,
    defaultValue: JSON.stringify({
      monday: { enabled: true, start: '08:00', end: '20:00' },
      tuesday: { enabled: true, start: '08:00', end: '20:00' },
      wednesday: { enabled: true, start: '08:00', end: '20:00' },
      thursday: { enabled: true, start: '08:00', end: '20:00' },
      friday: { enabled: true, start: '08:00', end: '20:00' },
      saturday: { enabled: true, start: '10:00', end: '22:00' },
      sunday: { enabled: true, start: '10:00', end: '22:00' },
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
