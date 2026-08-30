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
  /**
   * Removing entries from the log stream, separable from reading it for the
   * same reason `reset_passwords` is separable from `manage_users` — and with
   * more at stake.
   *
   * `view_audit_logs` is held by Operations as well as Super Admin, because
   * reading the stream is ordinary work. Deleting from it is not: the audit
   * trail is the record of what staff did, so anyone who can erase it can erase
   * their own tracks. This is granted to Super Admin alone, which is why it is
   * its own key rather than an extension of the permission next to it.
   *
   * It does not make the trail erasable without trace — see `clearLogs`.
   */
  MANAGE_AUDIT_LOGS: 'manage_audit_logs',
  /**
   * The public contact form's inbox.
   *
   * Its own key rather than part of `manage_users`, because the people in it are
   * mostly *not* users: anyone can write to the form without an account, and
   * their name, address and message are stored whatever becomes of the
   * notification. Reading a prospective customer's enquiry is support work;
   * opening the customer directory is not the same job and should not be the
   * same grant.
   */
  VIEW_CONTACT_MESSAGES: 'view_contact_messages',
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
    PERMISSIONS.VIEW_CONTACT_MESSAGES,
  ],
  // Resetting a locked-out customer's password is core support work, and so is
  // reading what someone wrote on the contact form before they had an account.
  [ROLES.SUPPORT]: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_SESSIONS,
    PERMISSIONS.RESET_PASSWORDS,
    PERMISSIONS.VIEW_CONTACT_MESSAGES,
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
