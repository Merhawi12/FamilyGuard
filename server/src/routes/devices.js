const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { getDevices, generateLink, confirmLink, removeDevice } = require('../controllers/deviceController');

const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many linking attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.get('/', getDevices);
router.post('/link', generateLink);
router.post('/confirm', confirmLimiter, confirmLink);
router.delete('/:id', removeDevice);

module.exports = router;
