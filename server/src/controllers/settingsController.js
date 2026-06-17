const { getSetting, setSetting } = require('../utils/settings');
const { DEFAULT_PLAN_FEATURES, FEATURE_LABELS } = require('../config/planFeatures');
const { auditLog } = require('../utils/auditLogger');

const DEFAULTS = {
  maintenanceMode: false,
  defaultTrialDays: 7,
  planFeatures: DEFAULT_PLAN_FEATURES,
};

// GET /admin/settings
const getSettings = async (req, res) => {
  try {
    const [maintenanceMode, defaultTrialDays, planFeatures] = await Promise.all([
      getSetting('maintenanceMode', DEFAULTS.maintenanceMode),
      getSetting('defaultTrialDays', DEFAULTS.defaultTrialDays),
      getSetting('planFeatures', DEFAULTS.planFeatures),
    ]);

    res.json({ maintenanceMode, defaultTrialDays, planFeatures, featureLabels: FEATURE_LABELS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT /admin/settings
const updateSettings = async (req, res) => {
  try {
    const { maintenanceMode, defaultTrialDays, planFeatures } = req.body;
    const updated = {};

    if (typeof maintenanceMode === 'boolean') updated.maintenanceMode = await setSetting('maintenanceMode', maintenanceMode);
    if (typeof defaultTrialDays === 'number' && defaultTrialDays > 0) updated.defaultTrialDays = await setSetting('defaultTrialDays', defaultTrialDays);
    if (planFeatures && typeof planFeatures === 'object') updated.planFeatures = await setSetting('planFeatures', planFeatures);

    auditLog(req, { userId: req.user.id, action: 'admin.settings_updated', entity: 'SystemSetting', metadata: updated });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getSettings, updateSettings };
