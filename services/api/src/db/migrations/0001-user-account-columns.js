const { DataTypes } = require('sequelize');

/**
 * Columns added to `users` after the table first shipped. Deployments created
 * before these existed need them backfilled; `sequelize.sync()` will not alter
 * an existing table, so they are added here.
 */
const COLUMNS = {
  notification_prefs: { type: DataTypes.TEXT, defaultValue: '{}' },
  permissions: { type: DataTypes.JSON, defaultValue: [] },
  last_login_at: { type: DataTypes.DATE },
  failed_login_attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  locked_until: { type: DataTypes.DATE },
  password_reset_token: { type: DataTypes.STRING },
  password_reset_expires: { type: DataTypes.DATE },
};

const columnNames = async (queryInterface) => {
  const description = await queryInterface.describeTable('users');
  return new Set(Object.keys(description));
};

module.exports = {
  async up(queryInterface) {
    const existing = await columnNames(queryInterface);
    for (const [name, definition] of Object.entries(COLUMNS)) {
      if (!existing.has(name)) await queryInterface.addColumn('users', name, definition);
    }
  },

  async down(queryInterface) {
    const existing = await columnNames(queryInterface);
    for (const name of Object.keys(COLUMNS)) {
      if (existing.has(name)) await queryInterface.removeColumn('users', name);
    }
  },
};
