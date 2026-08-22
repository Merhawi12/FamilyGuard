const { DataTypes } = require('sequelize');

/**
 * Per-device block and per-device rules.
 *
 * A family with two devices on one child had exactly one lever for both: rules
 * were keyed on `child_id` alone, so the homework laptop and the bedtime tablet
 * could never be told apart, and the only per-device action was removal — which
 * is permanent and needs a fresh linking code to undo.
 *
 * Two additive columns, both nullable, both meaning "as before" when unset:
 *
 * - `devices.blocked_at` — when the parent paused this one device. Distinct from
 *   `is_active`, which means *removed*; see the model for why they must not be
 *   the same flag.
 * - `device_id` on the three rule tables — NULL keeps a rule child-wide, which
 *   is what every existing row is and what the dashboard writes by default.
 *
 * Nothing is backfilled and nothing changes behaviour on its own: a database
 * that has run this migration and no new writes answers every query exactly as
 * it did before.
 *
 * `device_id` is indexed on all three because it is read on the sync path
 * ([[0015]] added the `child_id` half) and because removing a device deletes its
 * rules by that column.
 *
 * No foreign key is declared, matching every other association in this schema —
 * the models carry the relationships and `removeDevice` does the cleanup.
 */
const RULE_TABLES = ['app_rules', 'website_rules', 'screen_time_rules'];

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
    const devicesHasBlockedAt = await hasColumn(queryInterface, 'devices', 'blocked_at');
    if (devicesHasBlockedAt === false) {
      await queryInterface.addColumn('devices', 'blocked_at', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    for (const table of RULE_TABLES) {
      const present = await hasColumn(queryInterface, table, 'device_id');
      if (present === null) continue;
      if (!present) {
        await queryInterface.addColumn(table, 'device_id', {
          type: DataTypes.UUID,
          allowNull: true,
        });
      }

      try {
        await queryInterface.addIndex(table, ['device_id'], { name: `${table}_device_id` });
      } catch (err) {
        // `sync()` may have created it from the model definition already, and on
        // a re-run it is simply there. Anything else is a real failure.
        if (!/already exists|duplicate/i.test(err.message)) throw err;
      }
    }
  },

  async down(queryInterface) {
    for (const table of RULE_TABLES) {
      try {
        await queryInterface.removeIndex(table, `${table}_device_id`);
      } catch { /* never created, or the table is gone */ }
      if (await hasColumn(queryInterface, table, 'device_id')) {
        await queryInterface.removeColumn(table, 'device_id');
      }
    }

    if (await hasColumn(queryInterface, 'devices', 'blocked_at')) {
      await queryInterface.removeColumn('devices', 'blocked_at');
    }
  },
};
