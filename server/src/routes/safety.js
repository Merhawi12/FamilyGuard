const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const { runAnalysis } = require('../controllers/safetyController');

router.post('/analyze', authenticate, requireFeature('ai_safety'), runAnalysis);

module.exports = router;
