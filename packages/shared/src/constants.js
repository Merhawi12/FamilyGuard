/** Roles the API recognises. `support` is staff with a restricted permission set. */
export const ROLES = { ADMIN: 'admin', SUPPORT: 'support', PARENT: 'parent' };

export const STAFF_ROLES = [ROLES.ADMIN, ROLES.SUPPORT];

export const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role);

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
