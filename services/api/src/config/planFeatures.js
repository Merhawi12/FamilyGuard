// Default plan -> feature entitlements. Overridable at runtime via the
// `planFeatures` SystemSetting (edited from the admin Settings screen).
const DEFAULT_PLAN_FEATURES = {
  free: [],
  premium: ['gps_tracking', 'geofencing', 'website_filtering'],
  family: ['gps_tracking', 'geofencing', 'website_filtering', 'ai_safety'],
};

// What a new account gets during its 7-day trial (see middleware/featureGate).
const TRIAL_PLAN = 'premium';

const FEATURE_LABELS = {
  gps_tracking: 'Real-time GPS Tracking',
  geofencing: 'Geofencing / Safe Zones',
  website_filtering: 'Website Filtering & Blocking',
  ai_safety: 'AI Safety & Cyberbullying Detection',
};

module.exports = { DEFAULT_PLAN_FEATURES, TRIAL_PLAN, FEATURE_LABELS };
