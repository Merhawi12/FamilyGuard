/**
 * Indexes for the queries on the read hot path: the activity feed, the location
 * history chart, and a parent's alert list. Without these, each turns into a
 * sequential scan as a family accumulates history.
 */
const INDEXES = [
  { table: 'activity_logs', fields: ['device_id'] },
  { table: 'activity_logs', fields: ['child_id', 'start_time'] },
  { table: 'locations', fields: ['device_id'] },
  { table: 'locations', fields: ['child_id', 'recorded_at'] },
  { table: 'alerts', fields: ['parent_id'] },
  { table: 'alerts', fields: ['child_id'] },
  { table: 'sessions', fields: ['user_id'] },
  { table: 'notifications', fields: ['user_id', 'is_read'] },
  { table: 'messages', fields: ['child_id', 'created_at'] },
];

const indexName = ({ table, fields }) => `${table}_${fields.join('_')}`;

module.exports = {
  async up(queryInterface) {
    for (const index of INDEXES) {
      try {
        await queryInterface.addIndex(index.table, index.fields, { name: indexName(index) });
      } catch (err) {
        // An index created by an earlier boot-time patch may already exist under
        // this name; anything else is a real failure.
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
