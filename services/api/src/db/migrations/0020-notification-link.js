const { DataTypes } = require('sequelize');

/**
 * Where a notification points — see models/Notification.js.
 *
 * One additive, nullable column. NULL means "nowhere in particular", which is
 * what every row written before this migration is and what a staff announcement
 * stays: an announcement is about nothing the reader can open. It is the
 * platform's own automatic notices that have a destination — a payment notice
 * that cannot take a finance operator to the payment is a dead end.
 *
 * Nothing is backfilled and nothing changes behaviour on its own: a database
 * that has run this and no new writes answers every query exactly as before.
 *
 * No index. The column is never filtered or ordered on — it is read off a row
 * that has already been found by `user_id`, which the existing index covers.
 * That is also what keeps this clear of the trap [[0016-per-device-controls]]
 * documents: an index declared on a model over a column a migration adds makes
 * `sync()` fail on every database that has not run the migration yet.
 */

/**
 * `describeTable` rather than catching a duplicate-column error, which is the
 * pattern the rest of this directory uses: the message differs between SQLite
 * and Postgres, and a matcher that is right on one engine silently swallows a
 * real failure on the other.
 */
const hasColumn = async (queryInterface, table, column) => {
  try {
    const columns = await queryInterface.describeTable(table);
    return Boolean(columns[column]);
  } catch {
    // The table does not exist — a database older than the model that needs it.
    return null;
  }
};

module.exports = {
  async up(queryInterface) {
    const present = await hasColumn(queryInterface, 'notifications', 'link');
    if (present === false) {
      await queryInterface.addColumn('notifications', 'link', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const present = await hasColumn(queryInterface, 'notifications', 'link');
    if (present === true) await queryInterface.removeColumn('notifications', 'link');
  },
};
