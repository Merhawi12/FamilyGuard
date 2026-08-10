/**
 * Columns for the web-history pipeline.
 *
 * `url_hash` is the blind index over the encrypted `url`: the ciphertext carries
 * a random IV, so equality lookups — "have we already recorded this domain for
 * this child in the last half hour?" and "show me only this site" — have nothing
 * to match on without it.
 *
 * `visit_count` folds repeat lookups of one domain onto a single row. Without it
 * every DNS query a page makes would be its own history entry.
 */
const { DataTypes } = require('sequelize');

const addColumn = async (queryInterface, table, column, spec) => {
  const describe = await queryInterface.describeTable(table);
  if (describe[column]) return;
  await queryInterface.addColumn(table, column, spec);
};

module.exports = {
  async up(queryInterface) {
    await addColumn(queryInterface, 'activity_logs', 'url_hash', {
      type: DataTypes.STRING,
      allowNull: true,
    });
    await addColumn(queryInterface, 'activity_logs', 'visit_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    });

    try {
      await queryInterface.addIndex('activity_logs', ['child_id', 'url_hash', 'start_time'], {
        name: 'activity_logs_child_id_url_hash_start_time',
      });
    } catch (err) {
      if (!/already exists|duplicate/i.test(err.message)) throw err;
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex('activity_logs', 'activity_logs_child_id_url_hash_start_time');
    } catch { /* not present */ }
    try { await queryInterface.removeColumn('activity_logs', 'url_hash'); } catch { /* not present */ }
    try { await queryInterface.removeColumn('activity_logs', 'visit_count'); } catch { /* not present */ }
  },
};
