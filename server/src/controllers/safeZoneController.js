const { SafeZone } = require('../models');
const { auditLog } = require('../utils/auditLogger');

const listZones = async (req, res) => {
  try {
    const where = { parentId: req.user.id };
    if (req.query.childId) where.childId = req.query.childId;
    const zones = await SafeZone.findAll({ where, order: [['createdAt', 'ASC']] });
    res.json(zones);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createZone = async (req, res) => {
  try {
    const { childId, name, type, latitude, longitude, radiusMeters, notifyOnEnter, notifyOnLeave } = req.body;
    if (!name || latitude == null || longitude == null) {
      return res.status(400).json({ error: 'name, latitude, longitude are required' });
    }

    const zone = await SafeZone.create({
      parentId: req.user.id,
      childId: childId || null,
      name,
      type: type || 'custom',
      latitude,
      longitude,
      radiusMeters: radiusMeters || 200,
      notifyOnEnter: notifyOnEnter !== false,
      notifyOnLeave: notifyOnLeave !== false,
    });

    auditLog(req, { userId: req.user.id, action: 'safezone.created', entity: 'SafeZone', entityId: zone.id, metadata: { name } });
    res.status(201).json(zone);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateZone = async (req, res) => {
  try {
    const zone = await SafeZone.findOne({ where: { id: req.params.id, parentId: req.user.id } });
    if (!zone) return res.status(404).json({ error: 'Safe zone not found' });

    const allowed = ['name', 'type', 'latitude', 'longitude', 'radiusMeters', 'isActive', 'notifyOnEnter', 'notifyOnLeave'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    await zone.update(updates);

    auditLog(req, { userId: req.user.id, action: 'safezone.updated', entity: 'SafeZone', entityId: zone.id });
    res.json(zone);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteZone = async (req, res) => {
  try {
    const zone = await SafeZone.findOne({ where: { id: req.params.id, parentId: req.user.id } });
    if (!zone) return res.status(404).json({ error: 'Safe zone not found' });

    auditLog(req, { userId: req.user.id, action: 'safezone.deleted', entity: 'SafeZone', entityId: zone.id, metadata: { name: zone.name } });
    await zone.destroy();
    res.json({ message: 'Safe zone deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { listZones, createZone, updateZone, deleteZone };
