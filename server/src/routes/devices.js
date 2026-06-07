const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getDevices, generateLink, confirmLink, removeDevice } = require('../controllers/deviceController');

router.use(authenticate);
router.get('/', getDevices);
router.post('/link', generateLink);
router.post('/confirm', confirmLink);
router.delete('/:id', removeDevice);

module.exports = router;
