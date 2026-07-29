const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getChildren, createChild, updateChild, deleteChild } = require('../controllers/childController');

router.use(authenticate);
router.get('/', getChildren);
router.post('/', createChild);
router.put('/:id', updateChild);
router.delete('/:id', deleteChild);

module.exports = router;
