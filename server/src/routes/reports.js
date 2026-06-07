const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getDailySummary, getWeeklySummary } = require('../controllers/reportController');

router.use(authenticate);
router.get('/:childId/daily', getDailySummary);
router.get('/:childId/weekly', getWeeklySummary);

module.exports = router;
