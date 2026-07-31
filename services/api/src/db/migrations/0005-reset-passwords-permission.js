/**
 * Adds the `reset_passwords` permission.
 *
 * Setting another person's password is separable from ordinary user
 * administration, so it became its own permission rather than riding on
 * `manage_users`. Operations and Customer Support get it by default — a
 * locked-out customer is their problem to solve — but accounts provisioned
 * before this migration carry a stored permissions array that predates the key,
 * so grant it to those rows explicitly.
 *
 * Super Admins hold every permission implicitly and need no backfill; their row
 * is topped up anyway so the console shows the same list it enforces.
 */
const GRANT_TO = ['super_admin', 'operations', 'support'];
const PERMISSION = 'reset_passwords';

/** JSON arrays land in a text column on SQLite and json/jsonb on Postgres. */
const readPermissions = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, role, permissions FROM users WHERE role IN (:roles)',
      { replacements: { roles: GRANT_TO } }
    );

    for (const row of rows) {
      const permissions = readPermissions(row.permissions);
      if (permissions.includes(PERMISSION)) continue;

      await queryInterface.sequelize.query(
        'UPDATE users SET permissions = :permissions WHERE id = :id',
        { replacements: { permissions: JSON.stringify([...permissions, PERMISSION]), id: row.id } }
      );
    }
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT id, permissions FROM users');

    for (const row of rows) {
      const permissions = readPermissions(row.permissions);
      if (!permissions.includes(PERMISSION)) continue;

      await queryInterface.sequelize.query(
        'UPDATE users SET permissions = :permissions WHERE id = :id',
        {
          replacements: {
            permissions: JSON.stringify(permissions.filter((p) => p !== PERMISSION)),
            id: row.id,
          },
        }
      );
    }
  },
};
