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

module.exports = {
  async up(queryInterface) {
    const permissions = JSON.stringify(ALL_PERMISSIONS);

    await queryInterface.sequelize.query(
      'UPDATE users SET role = :next, permissions = :permissions WHERE role = :previous',
      { replacements: { next: 'super_admin', previous: 'admin', permissions } }
    );

    // Support accounts predate the defaults, so seed any that were left empty.
    await queryInterface.sequelize.query(
      `UPDATE users SET permissions = :permissions
       WHERE role = :role AND (permissions IS NULL OR permissions = '[]' OR permissions = '')`,
      {
        replacements: {
          role: 'support',
          permissions: JSON.stringify(['manage_users', 'manage_sessions']),
        },
      }
    );
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
