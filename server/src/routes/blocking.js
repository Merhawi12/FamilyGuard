const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const {
  getAppRules, addAppRule, removeAppRule,
  getWebsiteRules, addWebsiteRule, removeWebsiteRule,
} = require('../controllers/blockingController');

router.use(authenticate);
router.get('/:childId/apps', getAppRules);
router.post('/:childId/apps', addAppRule);
router.delete('/:childId/apps/:ruleId', removeAppRule);
router.get('/:childId/websites', requireFeature('website_filtering'), getWebsiteRules);
router.post('/:childId/websites', requireFeature('website_filtering'), addWebsiteRule);
router.delete('/:childId/websites/:ruleId', requireFeature('website_filtering'), removeWebsiteRule);

module.exports = router;
