const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getContacts, createContact, updateContact, deleteContact } = require('../controllers/contactController');

router.get('/', authenticate, getContacts);
router.post('/', authenticate, createContact);
router.put('/:id', authenticate, updateContact);
router.delete('/:id', authenticate, deleteContact);

module.exports = router;
