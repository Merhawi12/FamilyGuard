const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getRule, updateRule } = require('../controllers/screenTimeController');

router.use(authenticate);
router.get('/:childId', getRule);
router.put('/:childId', updateRule);

module.exports = router;
