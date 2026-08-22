const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getDailySummary, getWeeklySummary, getFamilyWeeklySummary } = require('../controllers/reportController');

router.use(authenticate);
// Declared before `/:childId/…` so the literal path is not read as a child id.
router.get('/weekly', getFamilyWeeklySummary);
router.get('/:childId/daily', getDailySummary);
router.get('/:childId/weekly', getWeeklySummary);

module.exports = router;
