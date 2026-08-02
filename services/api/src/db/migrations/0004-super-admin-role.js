/**
 * Introduces the department role model.
 *
 * The single `admin` role became `super_admin` — the only role that can manage
 * staff accounts. Every existing admin is promoted so nobody loses access on
 * deploy, and their permissions column is filled in with the full set: it used
 * to be ignored for admins (the old permission check short-circuited on
 * `role === 'admin'`), so most admin rows carry an empty array.
 *
 * `support` keeps its name and becomes Customer Support. The new Finance,
 * Operations and Marketing roles have no existing rows to migrate.
 */
const ALL_PERMISSIONS = [
  'manage_users',
  'manage_sessions',
  'manage_billing',
  'manage_settings',
  'send_notifications',
  'view_audit_logs',
];

/**
 * A json column arrives parsed from Postgres and as raw text from SQLite, so
 * both shapes have to be recognised as "nothing granted yet".
 */
const isEmptyPermissions = (raw) => {
  if (raw === null || raw === undefined) return true;
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
};

module.exports = {
  async up(queryInterface) {
    const permissions = JSON.stringify(ALL_PERMISSIONS);

    await queryInterface.sequelize.query(
      'UPDATE users SET role = :next, permissions = :permissions WHERE role = :previous',
      { replacements: { next: 'super_admin', previous: 'admin', permissions } }
    );

    // Support accounts predate the defaults, so seed any that were left empty.
    //
    // "Left empty" is decided in JS rather than in the WHERE clause: `permissions`
    // is a json column, and Postgres defines no equality operator for json, so
    // comparing it to '[]' fails to parse — on an empty table too, because
    // operators resolve before any row is read. SQLite stores json as text and
    // would accept it, which is exactly why this has to be dialect-agnostic.
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, permissions FROM users WHERE role = :role',
      { replacements: { role: 'support' } }
    );

    const supportPermissions = JSON.stringify(['manage_users', 'manage_sessions']);
    for (const row of rows) {
      if (!isEmptyPermissions(row.permissions)) continue;
      await queryInterface.sequelize.query(
        'UPDATE users SET permissions = :permissions WHERE id = :id',
        { replacements: { permissions: supportPermissions, id: row.id } }
      );
    }
  },

  async down(queryInterface) {
    // The department roles have no pre-existing equivalent, so they collapse
    // back onto the roles that did exist.
    await queryInterface.sequelize.query(
      'UPDATE users SET role = :next WHERE role = :previous',
      { replacements: { next: 'admin', previous: 'super_admin' } }
    );

    await queryInterface.sequelize.query(
      "UPDATE users SET role = 'support' WHERE role IN ('operations', 'finance', 'marketing')"
    );
  },
};
