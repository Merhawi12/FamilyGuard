const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { setup, enable, disable, validate } = require('../controllers/mfaController');

// validate is the second login step — no session JWT yet, uses preAuthToken instead
router.post('/validate', validate);

// All other MFA actions require a valid session
router.use(authenticate);
router.post('/setup', setup);
router.post('/enable', enable);
router.post('/disable', disable);

module.exports = router;
