const { SafeZone, Child } = require('../models');
const { auditLog } = require('../utils/auditLogger');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const findOwnZone = (id, parentId) =>
  (isUuid(id) ? SafeZone.findOne({ where: { id, parentId } }) : null);

const listZones = async (req, res, next) => {
  try {
    const where = { parentId: req.user.id };
    if (req.query.childId) {
      // An id that cannot match anything is answered with the empty list a
      // filter is entitled to, rather than a database error.
      if (!isUuid(req.query.childId)) return res.json([]);
      where.childId = req.query.childId;
    }
    const zones = await SafeZone.findAll({ where, order: [['createdAt', 'ASC']] });
    res.json(zones);
  } catch (err) {
    next(err);
  }
};

const createZone = async (req, res, next) => {
  try {
    const { childId, name, type, latitude, longitude, radiusMeters, notifyOnEnter, notifyOnLeave } = req.body;
    if (!name || latitude == null || longitude == null) {
      return res.status(400).json({ error: 'name, latitude, longitude are required' });
    }

    /**
     * A zone scoped to a child has to be scoped to one of *this parent's*
     * children. Nothing checked that: any childId the caller supplied was
     * written straight onto the row. The zone still only ever fired for its own
     * parent — `checkGeofences` filters on `parentId` — so this was never a way
     * to read another family's movements, but it did let a stranger's child id
     * be stored on, and read back from, this account's records, and a malformed
     * one reached Postgres as a UUID and answered 500.
     */
    if (childId) {
      const child = isUuid(childId)
        ? await Child.findOne({ where: { id: childId, parentId: req.user.id } })
        : null;
      if (!child) return res.status(404).json({ error: 'Child not found' });
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
    next(err);
  }
};

const updateZone = async (req, res, next) => {
  try {
    const zone = await findOwnZone(req.params.id, req.user.id);
    if (!zone) return res.status(404).json({ error: 'Safe zone not found' });

    const allowed = ['name', 'type', 'latitude', 'longitude', 'radiusMeters', 'isActive', 'notifyOnEnter', 'notifyOnLeave'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    await zone.update(updates);

    auditLog(req, { userId: req.user.id, action: 'safezone.updated', entity: 'SafeZone', entityId: zone.id });
    res.json(zone);
  } catch (err) {
    next(err);
  }
};

const deleteZone = async (req, res, next) => {
  try {
    const zone = await findOwnZone(req.params.id, req.user.id);
    if (!zone) return res.status(404).json({ error: 'Safe zone not found' });

    auditLog(req, { userId: req.user.id, action: 'safezone.deleted', entity: 'SafeZone', entityId: zone.id, metadata: { name: zone.name } });
    await zone.destroy();
    res.json({ message: 'Safe zone deleted' });
  } catch (err) {
    next(err);
  }
};

module.exports = { listZones, createZone, updateZone, deleteZone };
