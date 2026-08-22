/**
 * Indexes for the tables every child device and every dashboard reads, and which
 * had none.
 *
 * [[0013]] covered the console's tables. This covers the product's: the ones on
 * the path a phone walks every few minutes and a parent walks on every page load.
 *
 * **The rules tables are the expensive ones.** `getDeviceSync` reads all three at
 * once — `AppRule.findAll({ where: { childId } })`,
 * `WebsiteRule.findAll({ where: { childId } })` and
 * `ScreenTimeRule.findOne({ where: { childId } })` — and every linked device asks
 * for it on a five-minute timer, plus on every socket `rules_updated`. Unindexed,
 * each of those is a sequential scan of every rule belonging to every family on
 * the platform, three times per device per tick. It is invisible at the current
 * size and gets linearly worse with both device count and rule count, which are
 * the two numbers this product grows by.
 *
 * `children` is read the same way from the other side — "this parent's active
 * children" opens the dashboard, the device list, the reports and the sync above.
 *
 * `notifications` and `messages` are both read newest-or-oldest-first for one
 * owner, so they take the ordering column into the index: without it Postgres can
 * use an index for the filter and then still sort the result, which is the part
 * that costs on a long-lived account. `notifications` in particular is polled by
 * the family app's bell.
 *
 * `sessions` is indexed on `user_id` rather than for reads — the hot path fetches
 * a session by primary key. It is `revokeAllSessions`, which runs on password
 * change, MFA change and account deactivation and updates every row a user owns.
 * That is a security action, and the slowest thing about it should not be finding
 * the rows.
 *
 * Model definitions carry the same indexes so `sequelize.sync()` gives a fresh
 * database them directly; this migration is for the databases that already exist.
 */
const INDEXES = [
  // Rules — read together on every device sync.
  { table: 'app_rules', fields: ['child_id'] },
  { table: 'website_rules', fields: ['child_id'] },
  { table: 'screen_time_rules', fields: ['child_id'] },

  // "This parent's active children", on nearly every authenticated screen.
  { table: 'children', fields: ['parent_id', 'is_active'] },

  // Owner + ordering column, because both of these are read in time order.
  { table: 'notifications', fields: ['user_id', 'created_at'] },
  { table: 'messages', fields: ['child_id', 'created_at'] },

  // Geofences, listed per parent.
  { table: 'safe_zones', fields: ['parent_id'] },

  // Bulk revocation, not lookup — see the note above.
  { table: 'sessions', fields: ['user_id'] },
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
      } catch {
        // Never created, or the table is gone. Nothing to undo either way.
      }
    }
  },
};
