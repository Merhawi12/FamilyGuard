const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const {
  getAppRules, listKnownApps, addAppRule, removeAppRule,
  getWebsiteRules, addWebsiteRule, removeWebsiteRule,
} = require('../controllers/blockingController');

router.use(authenticate);
// Before `/:childId/apps` would not matter (the paths differ), but keeping the
// more specific one first is the habit that stops the next added segment from
// being swallowed by a parameter.
router.get('/:childId/apps/known', listKnownApps);
router.get('/:childId/apps', getAppRules);
router.post('/:childId/apps', addAppRule);
router.delete('/:childId/apps/:ruleId', removeAppRule);
router.get('/:childId/websites', requireFeature('website_filtering'), getWebsiteRules);
router.post('/:childId/websites', requireFeature('website_filtering'), addWebsiteRule);
router.delete('/:childId/websites/:ruleId', requireFeature('website_filtering'), removeWebsiteRule);

module.exports = router;
