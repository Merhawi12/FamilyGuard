/**
 * Extra minutes, granted for one day — see models/ScreenTimeGrant.js.
 *
 * The `screen_time_grants` table itself is created by `sequelize.sync()` along
 * with every other table, so this migration only covers what sync will not do on
 * a database that already has it: add the index the sync path reads.
 *
 * On every database deployed today the table is genuinely new, so sync creates it
 * with the model's index already on it and everything below is a no-op. It exists
 * for the case sync cannot cover — a database that acquired the table from an
 * earlier build of this branch, before the index was declared.
 *
 * This is the same shape as [[0008-push-tokens]], and the opposite of the trap
 * [[0016-per-device-controls]] documents: an index declared on a model over a
 * column a migration *adds* makes sync fail on every existing database. Declaring
 * one over a column that arrives with the table is fine.
 */
const INDEXES = [
  { table: 'screen_time_grants', fields: ['child_id', 'created_at'] },
];

const indexName = ({ table, fields }) => `${table}_${fields.join('_')}`;

module.exports = {
  async up(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const present = tables.map((t) => (typeof t === 'string' ? t : t.tableName));
    if (!present.includes('screen_time_grants')) return;

    for (const index of INDEXES) {
      try {
        await queryInterface.addIndex(index.table, index.fields, { name: indexName(index) });
      } catch (err) {
        // sync() may have created it from the model definition already, and on a
        // re-run it is simply there. Anything else is a real failure.
        if (!/already exists|duplicate/i.test(err.message)) throw err;
      }
    }
  },

  async down(queryInterface) {
    for (const index of INDEXES) {
      try {
        await queryInterface.removeIndex(index.table, indexName(index));
      } catch { /* never created, or the table is gone */ }
    }
  },
};
