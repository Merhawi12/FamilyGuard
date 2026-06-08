const router = require('express').Router();
const { register, login, me, verifyEmail } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/register', register);
router.post('/verify-email', verifyEmail);
router.post('/login', login);
router.get('/me', authenticate, me);

module.exports = router;
