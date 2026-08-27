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
  MANAGE_AUDIT_LOGS: 'manage_audit_logs',
};

export const PERMISSION_LABELS = {
  [PERMISSIONS.MANAGE_USERS]: 'Manage users',
  [PERMISSIONS.MANAGE_SESSIONS]: 'Manage sessions',
  [PERMISSIONS.MANAGE_BILLING]: 'Manage billing',
  [PERMISSIONS.MANAGE_SETTINGS]: 'Manage settings',
  [PERMISSIONS.SEND_NOTIFICATIONS]: 'Send notifications',
  [PERMISSIONS.VIEW_AUDIT_LOGS]: 'View audit logs',
  [PERMISSIONS.RESET_PASSWORDS]: 'Reset passwords',
  [PERMISSIONS.MANAGE_AUDIT_LOGS]: 'Delete audit logs',
};

export const PERMISSION_DESCRIPTIONS = {
  [PERMISSIONS.MANAGE_USERS]: 'Open the user directory; edit, block and delete customer accounts.',
  [PERMISSIONS.MANAGE_SESSIONS]: 'See who is signed in and force them out.',
  [PERMISSIONS.MANAGE_BILLING]: 'Read transactions and subscription records.',
  [PERMISSIONS.MANAGE_SETTINGS]: 'Change platform settings, including plan entitlements.',
  [PERMISSIONS.SEND_NOTIFICATIONS]: 'Send announcements to customers.',
  [PERMISSIONS.VIEW_AUDIT_LOGS]: 'Read the audit trail of staff actions.',
  [PERMISSIONS.RESET_PASSWORDS]: "Set a customer's password, taking over their account.",
  [PERMISSIONS.MANAGE_AUDIT_LOGS]: 'Remove entries from the log stream. Every deletion is itself recorded.',
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

/**
 * The pricing catalogue as the web apps see it.
 *
 * Mirrors `services/api/src/config/plans.js` — same keys, same order, same
 * amounts — and `tests/sharedConstants.test.js` fails when they diverge. The
 * price and the entitlements a customer is shown must be the ones the API
 * charges and enforces; they lived in four places before and disagreed.
 *
 * `amountCents` is the billed amount. `features` is marketing copy for the
 * pricing cards; what the API actually gates on is `featureKeys`.
 */
export const PLANS = { FREE: 'free', PREMIUM: 'premium' };

export const PLAN_CATALOGUE = [
  {
    key: PLANS.FREE,
    label: 'Free Plan',
    amountCents: 0,
    price: '$0',
    period: '/ 7 days',
    badge: '7 days only',
    featureKeys: [],
    maxDevices: 1,
    features: [
      'Basic screen time monitoring',
      'Daily activity reports',
      '1 child device',
      'Basic parental controls',
      'Email support',
    ],
    warning: 'Trial expires after 7 days',
  },
  {
    key: PLANS.PREMIUM,
    label: 'Premium Plan',
    amountCents: 999,
    price: '$9.99',
    period: '/mo',
    popular: true,
    featureKeys: ['gps_tracking', 'geofencing', 'website_filtering', 'ai_safety'],
    maxDevices: null,
    features: [
      'Everything in Free',
      'Real-time GPS tracking',
      'Geofencing alerts',
      'App usage monitoring',
      'Website filtering & blocking',
      'Screen time scheduling',
      'Unlimited child devices',
      'AI-powered safety alerts',
      'Social media monitoring',
      'Cyberbullying detection',
      'Advanced family reports',
      'Instant emergency notifications',
      'Priority support',
    ],
  },
];

export const PLAN_KEYS = PLAN_CATALOGUE.map((p) => p.key);

/** Plans a customer can check out. Free is not one of them. */
export const PAID_PLAN_KEYS = PLAN_CATALOGUE.filter((p) => p.amountCents > 0).map((p) => p.key);

/** An account parked here is switched off; it is not a tier anyone buys. */
export const SUSPENDED_PLAN = 'suspended';

const PLAN_BY_KEY = Object.fromEntries(PLAN_CATALOGUE.map((p) => [p.key, p]));

export const planLabel = (key) =>
  (key === SUSPENDED_PLAN ? 'Suspended' : PLAN_BY_KEY[key]?.label) || key || 'Unknown';

/** True for any tier that is billed — the test for "this account pays us". */
export const isPaidPlan = (key) => PAID_PLAN_KEYS.includes(key);

/** Human labels for the alert types the backend emits. */
/**
 * The content categories a filter rule can name.
 *
 * Mirrors `services/api/src/config/contentCategories.js` — labels and
 * descriptions only; the domain lists behind them stay on the server, which is
 * where a category is expanded into the names a device can block. Change both
 * together; `sharedConstants.test.js` fails the build when they drift.
 */
export const CONTENT_CATEGORIES = [
  { key: 'adult', label: 'Adult Content', description: 'Pornography, explicit imagery' },
  { key: 'gambling', label: 'Gambling', description: 'Betting, casinos, lotteries' },
  { key: 'social_media', label: 'Social Media', description: 'Facebook, Instagram, TikTok' },
  { key: 'gaming', label: 'Gaming', description: 'Online games, gaming portals' },
  { key: 'streaming', label: 'Streaming Media', description: 'Netflix, YouTube, Hulu' },
  { key: 'file_sharing', label: 'File Sharing', description: 'Torrents, P2P networks' },
];

export const CONTENT_CATEGORY_KEYS = CONTENT_CATEGORIES.map((c) => c.key);

/** Keys no longer offered, so a rule stored under one still reads. */
export const LEGACY_CATEGORY_LABELS = {
  violence: 'Violence',
  custom: 'Custom',
};

export const categoryLabel = (key) =>
  CONTENT_CATEGORIES.find((c) => c.key === key)?.label || LEGACY_CATEGORY_LABELS[key] || key;

export const ALERT_LABELS = {
  left_safe_zone: 'Left Safe Zone',
  entered_safe_zone: 'Arrived at Safe Zone',
  dangerous_content: 'Risky Site Opened',
  emergency_button: 'Emergency Alert',
  cyberbullying: 'Cyberbullying Detected',
  screen_time_exceeded: 'Screen Time Exceeded',
  blocked_app: 'Blocked App Attempt',
  blocked_app_attempt: 'Blocked App Attempt',
  app_installed: 'New App Used',
  safety_pattern: 'Safety Pattern Detected',
};

export const alertLabel = (type) => ALERT_LABELS[type] || type;
