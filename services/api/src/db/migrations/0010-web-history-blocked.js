/**
 * `blocked` on a web-history row.
 *
 * The device has always reported it — the DNS proxy answers NXDOMAIN for a
 * blocked name and `WebHistoryReporter.record(domain, blocked)` sends the flag
 * with the visit — and the ingest endpoint dropped it on the floor. So the one
 * thing a filtering screen most needs to say, "this was stopped", was being
 * thrown away on arrival.
 *
 * The index is over the three columns the fleet-wide aggregate reads together:
 * blocked rows, in a window, grouped by domain.
 */
const { DataTypes } = require('sequelize');

const addColumn = async (queryInterface, table, column, spec) => {
  const describe = await queryInterface.describeTable(table);
  if (describe[column]) return;
  await queryInterface.addColumn(table, column, spec);
};

module.exports = {
  async up(queryInterface) {
    await addColumn(queryInterface, 'activity_logs', 'blocked', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    try {
      await queryInterface.addIndex('activity_logs', ['blocked', 'start_time', 'url_hash'], {
        name: 'activity_logs_blocked_start_time_url_hash',
      });
    } catch (err) {
      if (!/already exists|duplicate/i.test(err.message)) throw err;
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex('activity_logs', 'activity_logs_blocked_start_time_url_hash');
    } catch { /* not present */ }
    try { await queryInterface.removeColumn('activity_logs', 'blocked'); } catch { /* not present */ }
  },
};
