const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { submitContactForm } = require('../controllers/contactFormController');

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many messages sent, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/', contactLimiter, submitContactForm);

module.exports = router;
