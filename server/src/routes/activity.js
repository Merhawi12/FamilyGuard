const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getActivity, logActivity } = require('../controllers/activityController');

router.use(authenticate);
router.get('/:childId', getActivity);
router.post('/', logActivity);

module.exports = router;
