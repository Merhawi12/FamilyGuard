const { getSetting } = require('../utils/settings');
const { DEFAULT_PLAN_FEATURES, FEATURE_LABELS, TRIAL_PLAN, PLAN_LIMITS } = require('../config/plans');
const { isStaffRole } = require('../config/roles');

const trialIsActive = (user) => !!user.trialEndsAt && new Date() < new Date(user.trialEndsAt);

/**
 * The plan whose entitlements apply to this user right now.
 *
 * Registration hands out a 7-day trial and the welcome email promises full
 * access during it, so an unexpired trial is entitled to the trial tier. Only a
 * `free` account is lifted — a paid plan is never rewritten, and once the trial
 * lapses the account falls back to `free` on its own.
 */
const effectivePlan = (user) => (user.plan === 'free' && trialIsActive(user) ? TRIAL_PLAN : user.plan);

const requireFeature = (featureKey) => async (req, res, next) => {
  // Staff accounts are not on a plan — entitlements only mean anything for a parent.
  if (isStaffRole(req.user.role)) return next();

  try {
    const planFeatures = await getSetting('planFeatures', DEFAULT_PLAN_FEATURES);
    const allowed = planFeatures[effectivePlan(req.user)] || [];
    if (allowed.includes(featureKey)) return next();

    return res.status(403).json({
      error: `Upgrade required: ${FEATURE_LABELS[featureKey] || featureKey} is not included in your current plan`,
      feature: featureKey,
      upgradeRequired: true,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * How many devices this account may link in total, or null for unlimited.
 *
 * Reads through `effectivePlan`, so a trial gets the Premium allowance for the
 * seven days it lasts and drops to the Free one when it lapses — the same rule
 * that governs features, rather than a second one that could disagree.
 */
const deviceAllowance = (user) => {
  if (isStaffRole(user.role)) return null;
  const limits = PLAN_LIMITS[effectivePlan(user)];
  // An unknown plan (a suspended account, say) gets the most restrictive answer
  // rather than an accidental free pass.
  return limits ? limits.maxDevices : 0;
};

module.exports = { requireFeature, effectivePlan, trialIsActive, deviceAllowance };
