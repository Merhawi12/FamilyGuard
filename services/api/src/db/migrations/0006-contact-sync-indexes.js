/**
 * Indexes for the contact sync path. Every child device re-reads its approved
 * contact list on each sync and on every parent edit, so `(child_id,
 * is_approved)` is read far more often than the parent-facing list is.
 */
const INDEXES = [
  { table: 'contacts', fields: ['parent_id'] },
  { table: 'contacts', fields: ['child_id', 'is_approved'] },
];

const indexName = ({ table, fields }) => `${table}_${fields.join('_')}`;

module.exports = {
  async up(queryInterface) {
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
      } catch {
        /* not present — nothing to undo */
      }
    }
  },
};
