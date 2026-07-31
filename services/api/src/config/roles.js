/**
 * Staff roles and what each one may do.
 *
 * A role is a department. It carries a default permission set, which a Super
 * Admin may then vary per account — so an exception does not need a new role.
 * `permissions` on the User row is the effective grant; the defaults here only
 * seed it at creation and when the role changes.
 *
 * Kept in step with `packages/shared/src/constants.js`, which the web apps read.
 * The API is CommonJS and outside the npm workspace, so the two cannot share a
 * module — change both together.
 */

const PARENT_ROLE = 'parent';

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  OPERATIONS: 'operations',
  SUPPORT: 'support',
  FINANCE: 'finance',
  MARKETING: 'marketing',
};

const PERMISSIONS = {
  MANAGE_USERS: 'manage_users',
  MANAGE_SESSIONS: 'manage_sessions',
  MANAGE_BILLING: 'manage_billing',
  MANAGE_SETTINGS: 'manage_settings',
  SEND_NOTIFICATIONS: 'send_notifications',
  VIEW_AUDIT_LOGS: 'view_audit_logs',
  /**
   * Setting someone else's password is a takeover of their account, so it is
   * separable from ordinary user administration: a Super Admin can let someone
   * edit customer records without also letting them seize one.
   */
  RESET_PASSWORDS: 'reset_passwords',
};

const PERMISSION_KEYS = Object.values(PERMISSIONS);

/**
 * Least privilege: only the roles whose job needs family data get
 * `manage_users`. Finance and Marketing work from billing records and
 * aggregate analytics, so neither can open the user directory.
 */
const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [...PERMISSION_KEYS],
  [ROLES.OPERATIONS]: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_SESSIONS,
    PERMISSIONS.MANAGE_SETTINGS,
    PERMISSIONS.VIEW_AUDIT_LOGS,
    PERMISSIONS.RESET_PASSWORDS,
  ],
  // Resetting a locked-out customer's password is core support work.
  [ROLES.SUPPORT]: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_SESSIONS,
    PERMISSIONS.RESET_PASSWORDS,
  ],
  [ROLES.FINANCE]: [PERMISSIONS.MANAGE_BILLING],
  [ROLES.MARKETING]: [PERMISSIONS.SEND_NOTIFICATIONS],
};

const STAFF_ROLES = Object.values(ROLES);

const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.OPERATIONS]: 'Operations',
  [ROLES.SUPPORT]: 'Customer Support',
  [ROLES.FINANCE]: 'Finance',
  [ROLES.MARKETING]: 'Marketing',
};

const isStaffRole = (role) => STAFF_ROLES.includes(role);
const isSuperAdmin = (user) => user?.role === ROLES.SUPER_ADMIN;

/** The permissions a role grants out of the box. */
const defaultPermissionsFor = (role) => [...(ROLE_PERMISSIONS[role] || [])];

/**
 * Whether a user holds a permission. A Super Admin holds every permission
 * implicitly, so removing one from their row cannot lock the platform out.
 */
const hasPermission = (user, permission) => {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
};

module.exports = {
  PARENT_ROLE,
  ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  STAFF_ROLES,
  isStaffRole,
  isSuperAdmin,
  defaultPermissionsFor,
  hasPermission,
};
