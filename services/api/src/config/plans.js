/**
 * The pricing catalogue — the one place a plan is defined.
 *
 * Price, label, entitlements and limits all live here together, because they
 * used to live apart: the amount was in the Stripe route, the entitlements
 * here, the copy in two React files and the landing page, and nothing made them
 * agree. `packages/shared/src/constants.js` restates the customer-facing half
 * for the web apps (the API is CommonJS and outside that workspace) and
 * `tests/sharedConstants.test.js` fails the build when the two drift.
 *
 * Two plans are sold: `free` and `premium`. The former `family` tier at $14.99
 * was folded into Premium — every feature it had is now Premium's — and
 * migration 0009 moves the accounts across.
 */

/** Ordered as the pricing page shows them. */
const PLANS = {
  free: {
    key: 'free',
    label: 'Free Plan',
    /** Cents per month. Free is free; nothing bills it. */
    amount: 0,
    /** Stripe price env var. Free has no Stripe product. */
    priceEnv: null,
    features: [],
    /** How many devices may be linked across all of a parent's children. */
    maxDevices: 1,
  },
  premium: {
    key: 'premium',
    label: 'Premium Plan',
    amount: 999,
    priceEnv: 'premiumPriceId',
    features: ['gps_tracking', 'geofencing', 'website_filtering', 'ai_safety'],
    /** null = unlimited. */
    maxDevices: null,
  },
};

/** Every sellable plan key, in display order. */
const PLAN_KEYS = Object.keys(PLANS);

/** Plans a customer can actually check out. Free is not one of them. */
const PAID_PLAN_KEYS = PLAN_KEYS.filter((key) => PLANS[key].amount > 0);

// Default plan -> feature entitlements. Overridable at runtime via the
// `planFeatures` SystemSetting (edited from the admin Settings screen).
const DEFAULT_PLAN_FEATURES = Object.fromEntries(
  PLAN_KEYS.map((key) => [key, [...PLANS[key].features]])
);

/** Device allowance per plan, same shape as above. Not runtime-overridable. */
const PLAN_LIMITS = Object.fromEntries(
  PLAN_KEYS.map((key) => [key, { maxDevices: PLANS[key].maxDevices }])
);

// What a new account gets during its 7-day trial (see middleware/featureGate).
const TRIAL_PLAN = 'premium';

/**
 * Not a plan so much as the absence of one: an account parked here is switched
 * off. Kept beside the catalogue so "every sellable plan" and "the off switch"
 * stay distinguishable wherever plans are validated.
 */
const SUSPENDED_PLAN = 'suspended';

/** Every plan value the `users.plan` column may legitimately hold. */
const ASSIGNABLE_PLANS = [...PLAN_KEYS, SUSPENDED_PLAN];

const FEATURE_LABELS = {
  gps_tracking: 'Real-time GPS Tracking',
  geofencing: 'Geofencing / Safe Zones',
  website_filtering: 'Website Filtering & Blocking',
  ai_safety: 'AI Safety & Cyberbullying Detection',
};

const planLabel = (key) => PLANS[key]?.label || key;

module.exports = {
  PLANS,
  PLAN_KEYS,
  PAID_PLAN_KEYS,
  ASSIGNABLE_PLANS,
  DEFAULT_PLAN_FEATURES,
  PLAN_LIMITS,
  TRIAL_PLAN,
  SUSPENDED_PLAN,
  FEATURE_LABELS,
  planLabel,
};
