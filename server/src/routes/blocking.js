const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getAppRules, addAppRule, removeAppRule,
  getWebsiteRules, addWebsiteRule, removeWebsiteRule,
} = require('../controllers/blockingController');

router.use(authenticate);
router.get('/:childId/apps', getAppRules);
router.post('/:childId/apps', addAppRule);
router.delete('/:childId/apps/:ruleId', removeAppRule);
router.get('/:childId/websites', getWebsiteRules);
router.post('/:childId/websites', addWebsiteRule);
router.delete('/:childId/websites/:ruleId', removeWebsiteRule);

module.exports = router;
