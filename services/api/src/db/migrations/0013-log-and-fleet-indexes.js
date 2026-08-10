/**
 * Indexes for three tables that had none, on queries the console runs constantly.
 *
 * `audit_logs` is the busiest table on the platform — every admin action, sign-in
 * and device event writes a row — and it was unindexed. System Logs and the
 * Overview alert panel both read it newest-first over a time window, filter the
 * actor by `user_id`, and match `action` by prefix to derive level and service;
 * without these each of those is a sequential scan over the whole history.
 *
 * `devices` is read as "the active devices of these children" on the device list,
 * on the plan's allowance check, and on every rules pull from a child app.
 * `transactions` backs one customer's billing history and the platform revenue
 * trend, both ordered by time.
 *
 * The tables themselves come from `sequelize.sync()`; the model definitions carry
 * the same indexes so a fresh database gets them there. This covers the
 * databases that already exist.
 */
const INDEXES = [
  { table: 'audit_logs', fields: ['created_at'] },
  { table: 'audit_logs', fields: ['user_id'] },
  { table: 'audit_logs', fields: ['action'] },
  { table: 'devices', fields: ['child_id', 'is_active'] },
  { table: 'transactions', fields: ['user_id', 'created_at'] },
  { table: 'transactions', fields: ['status', 'created_at'] },
];

const indexName = ({ table, fields }) => `${table}_${fields.join('_')}`;

module.exports = {
  async up(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const present = tables.map((t) => (typeof t === 'string' ? t : t.tableName));

    for (const index of INDEXES) {
      if (!present.includes(index.table)) continue;
      try {
        await queryInterface.addIndex(index.table, index.fields, { name: indexName(index) });
      } catch (err) {
        // sync() may have created it from the model definition already; anything
        // else is a real failure.
        if (!/already exists|duplicate/i.test(err.message)) throw err;
      }
    }
  },

  async down(queryInterface) {
    for (const index of INDEXES) {
      try {
        await queryInterface.removeIndex(index.table, indexName(index));
      } catch { /* not present — nothing to undo */ }
    }
  },
};
