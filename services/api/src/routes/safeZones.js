const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const { listZones, createZone, updateZone, deleteZone } = require('../controllers/safeZoneController');

router.use(authenticate, requireFeature('geofencing'));
router.get('/', listZones);
router.post('/', createZone);
router.put('/:id', updateZone);
router.delete('/:id', deleteZone);

module.exports = router;
