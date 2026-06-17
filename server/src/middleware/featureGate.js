const { getSetting } = require('../utils/settings');
const { DEFAULT_PLAN_FEATURES, FEATURE_LABELS } = require('../config/planFeatures');

const requireFeature = (featureKey) => async (req, res, next) => {
  if (req.user.role === 'admin') return next();

  try {
    const planFeatures = await getSetting('planFeatures', DEFAULT_PLAN_FEATURES);
    const allowed = planFeatures[req.user.plan] || [];
    if (allowed.includes(featureKey)) return next();

    return res.status(403).json({
      error: `Upgrade required: ${FEATURE_LABELS[featureKey] || featureKey} is not included in your current plan`,
      feature: featureKey,
      upgradeRequired: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { requireFeature };
