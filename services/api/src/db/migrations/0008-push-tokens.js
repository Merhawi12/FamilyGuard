/**
 * The `push_tokens` table is created by `sequelize.sync()` along with every
 * other table, so this migration only covers what sync will not do on a database
 * that already has the table: add the indexes the send path relies on.
 *
 * Sends fan out per recipient — every active browser for a parent, every active
 * device for a child — and run on the alert hot path, so both lookups are
 * indexed, as is the token hash used to recognise a re-registration.
 */
const INDEXES = [
  { table: 'push_tokens', fields: ['user_id', 'is_active'] },
  { table: 'push_tokens', fields: ['device_id', 'is_active'] },
  { table: 'push_tokens', fields: ['token_hash'] },
];

const indexName = ({ table, fields }) => `${table}_${fields.join('_')}`;

module.exports = {
  async up(queryInterface) {
    // A fresh database gets the table from sync() before migrations run; a very
    // old one may not have it yet, in which case sync() on this boot creates it
    // and the indexes come with the model definition.
    const tables = await queryInterface.showAllTables();
    const present = tables.map((t) => (typeof t === 'string' ? t : t.tableName));
    if (!present.includes('push_tokens')) return;

    for (const index of INDEXES) {
      try {
        await queryInterface.addIndex(index.table, index.fields, { name: indexName(index) });
      } catch (err) {
        if (!/already exists|duplicate/i.test(err.message)) throw err;
      }
    }
  },

  async down(queryInterface) {
    for (const index of INDEXES) {
      try {
        await queryInterface.removeIndex(index.table, indexName(index));
      } catch { /* not present */ }
    }
  },
};
