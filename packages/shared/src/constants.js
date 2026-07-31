/**
 * Staff roles are departments. Each carries a default permission set that a
 * Super Admin can vary per account.
 *
 * Mirrors `services/api/src/config/roles.js` — the API is CommonJS and outside
 * this workspace, so the two cannot share a module. Change both together.
 */
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  OPERATIONS: 'operations',
  SUPPORT: 'support',
  FINANCE: 'finance',
  MARKETING: 'marketing',
  PARENT: 'parent',
};

export const STAFF_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.OPERATIONS,
  ROLES.SUPPORT,
  ROLES.FINANCE,
  ROLES.MARKETING,
];

export const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.OPERATIONS]: 'Operations',
  [ROLES.SUPPORT]: 'Customer Support',
  [ROLES.FINANCE]: 'Finance',
  [ROLES.MARKETING]: 'Marketing',
  [ROLES.PARENT]: 'Parent',
};

export const roleLabel = (role) => ROLE_LABELS[role] || role;

export const PERMISSIONS = {
  MANAGE_USERS: 'manage_users',
  MANAGE_SESSIONS: 'manage_sessions',
  MANAGE_BILLING: 'manage_billing',
  MANAGE_SETTINGS: 'manage_settings',
  SEND_NOTIFICATIONS: 'send_notifications',
  VIEW_AUDIT_LOGS: 'view_audit_logs',
  RESET_PASSWORDS: 'reset_passwords',
};

export const PERMISSION_LABELS = {
  [PERMISSIONS.MANAGE_USERS]: 'Manage users',
  [PERMISSIONS.MANAGE_SESSIONS]: 'Manage sessions',
  [PERMISSIONS.MANAGE_BILLING]: 'Manage billing',
  [PERMISSIONS.MANAGE_SETTINGS]: 'Manage settings',
  [PERMISSIONS.SEND_NOTIFICATIONS]: 'Send notifications',
  [PERMISSIONS.VIEW_AUDIT_LOGS]: 'View audit logs',
  [PERMISSIONS.RESET_PASSWORDS]: 'Reset passwords',
};

export const PERMISSION_DESCRIPTIONS = {
  [PERMISSIONS.MANAGE_USERS]: 'Open the user directory; edit, block and delete customer accounts.',
  [PERMISSIONS.MANAGE_SESSIONS]: 'See who is signed in and force them out.',
  [PERMISSIONS.MANAGE_BILLING]: 'Read transactions and subscription records.',
  [PERMISSIONS.MANAGE_SETTINGS]: 'Change platform settings, including plan entitlements.',
  [PERMISSIONS.SEND_NOTIFICATIONS]: 'Send announcements to customers.',
  [PERMISSIONS.VIEW_AUDIT_LOGS]: 'Read the audit trail of staff actions.',
  [PERMISSIONS.RESET_PASSWORDS]: "Set a customer's password, taking over their account.",
};

export const PERMISSION_KEYS = Object.values(PERMISSIONS);

/** What each department gets out of the box. Kept in step with the API. */
export const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [...PERMISSION_KEYS],
  [ROLES.OPERATIONS]: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_SESSIONS,
    PERMISSIONS.MANAGE_SETTINGS,
    PERMISSIONS.VIEW_AUDIT_LOGS,
    PERMISSIONS.RESET_PASSWORDS,
  ],
  [ROLES.SUPPORT]: [
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_SESSIONS,
    PERMISSIONS.RESET_PASSWORDS,
  ],
  [ROLES.FINANCE]: [PERMISSIONS.MANAGE_BILLING],
  [ROLES.MARKETING]: [PERMISSIONS.SEND_NOTIFICATIONS],
};

export const defaultPermissionsFor = (role) => [...(ROLE_PERMISSIONS[role] || [])];

export const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role);

export const isSuperAdmin = (user) => user?.role === ROLES.SUPER_ADMIN;

/** A Super Admin holds every permission implicitly, exactly as the API decides it. */
export const hasPermission = (user, permission) => {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
};

export const PLANS = { FREE: 'free', PREMIUM: 'premium', FAMILY: 'family' };

/** Human labels for the alert types the backend emits. */
export const ALERT_LABELS = {
  left_safe_zone: 'Left Safe Zone',
  entered_safe_zone: 'Arrived at Safe Zone',
  dangerous_content: 'Dangerous Content Detected',
  emergency_button: 'Emergency Alert',
  cyberbullying: 'Cyberbullying Detected',
  screen_time_exceeded: 'Screen Time Exceeded',
  blocked_app: 'Blocked App Attempt',
  blocked_app_attempt: 'Blocked App Attempt',
  app_installed: 'New App Installed',
  unknown_contact: 'Unknown Contact',
  safety_pattern: 'Safety Pattern Detected',
};

export const alertLabel = (type) => ALERT_LABELS[type] || type;
