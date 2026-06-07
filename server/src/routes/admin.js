const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { listClients, toggleBlock, updatePlan, deleteClient } = require('../controllers/adminController');

router.use(authenticate, requireRole('admin'));

router.get('/clients', listClients);
router.patch('/clients/:id/toggle-block', toggleBlock);
router.patch('/clients/:id/plan', updatePlan);
router.delete('/clients/:id', deleteClient);

module.exports = router;
