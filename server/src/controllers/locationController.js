const { Op } = require('sequelize');
const { Location, Child, Device, SafeZone, Alert } = require('../models');

// Haversine distance in metres between two lat/lng points
const haversineMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// POST /api/locations  — called by child device (mobile app)
// Body: { childId, deviceId, latitude, longitude, accuracy?, speed?, heading?, address? }
const postLocation = async (req, res) => {
  try {
    const { childId, deviceId, latitude, longitude, accuracy, speed, heading, address } = req.body;
    if (!childId || !deviceId || latitude == null || longitude == null) {
      return res.status(400).json({ error: 'childId, deviceId, latitude, longitude are required' });
    }

    const location = await Location.create({
      childId, deviceId, latitude, longitude, accuracy, speed, heading, address,
      recordedAt: new Date(),
    });

    // Update device heartbeat
    await Device.update({ lastSeen: new Date() }, { where: { id: deviceId } });

    // Broadcast real-time update to parent via socket
    const child = await Child.findByPk(childId, { attributes: ['parentId'] });
    if (child) {
      const io = req.app.get('io');
      io.to(`parent:${child.parentId}`).emit('location:update', {
        childId, latitude, longitude, accuracy, speed, heading, address,
        recordedAt: location.recordedAt,
      });

      // Geofence check
      await checkGeofences(req, child.parentId, childId, latitude, longitude, io);
    }

    res.status(201).json(location);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Checks all active safe zones for this child's parent and fires leave/enter alerts as needed.
// Uses the previous location stored in metadata to detect transitions.
const checkGeofences = async (req, parentId, childId, lat, lng, io) => {
  const zones = await SafeZone.findAll({
    where: {
      parentId,
      isActive: true,
      [Op.or]: [{ childId }, { childId: null }],
    },
  });

  // Get the second-most-recent location to determine previous position
  const [prev] = await Location.findAll({
    where: { childId },
    order: [['recordedAt', 'DESC']],
    limit: 1,
    offset: 1,
    attributes: ['latitude', 'longitude'],
  });

  for (const zone of zones) {
    const distNow = haversineMeters(lat, lng, zone.latitude, zone.longitude);
    const insideNow = distNow <= zone.radiusMeters;

    let insidePrev = null;
    if (prev) {
      const distPrev = haversineMeters(prev.latitude, prev.longitude, zone.latitude, zone.longitude);
      insidePrev = distPrev <= zone.radiusMeters;
    }

    const justEntered = insideNow && insidePrev === false;
    const justLeft = !insideNow && insidePrev === true;

    if (justEntered && zone.notifyOnEnter) {
      const alert = await Alert.create({
        parentId,
        childId,
        type: 'entered_safe_zone',
        message: `Child arrived at ${zone.name}`,
        severity: 'medium',
        metadata: JSON.stringify({ zoneId: zone.id, zoneName: zone.name, lat, lng }),
      });
      io.to(`parent:${parentId}`).emit('alert:new', alert);
    }

    if (justLeft && zone.notifyOnLeave) {
      const alert = await Alert.create({
        parentId,
        childId,
        type: 'left_safe_zone',
        message: `Child left ${zone.name}`,
        severity: 'high',
        metadata: JSON.stringify({ zoneId: zone.id, zoneName: zone.name, lat, lng }),
      });
      io.to(`parent:${parentId}`).emit('alert:new', alert);
    }
  }
};

// GET /api/locations/:childId/current  — latest known position
const getCurrentLocation = async (req, res) => {
  try {
    const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const location = await Location.findOne({
      where: { childId: child.id },
      order: [['recordedAt', 'DESC']],
      include: ['device'],
    });

    res.json(location || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/locations/:childId/history  — paginated route history
const getHistory = async (req, res) => {
  try {
    const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { from, to, limit = 100, offset = 0 } = req.query;
    const where = { childId: child.id };
    if (from || to) {
      where.recordedAt = {};
      if (from) where.recordedAt[Op.gte] = new Date(from);
      if (to) where.recordedAt[Op.lte] = new Date(to);
    }

    const history = await Location.findAndCountAll({
      where,
      order: [['recordedAt', 'DESC']],
      limit: Math.min(parseInt(limit), 500),
      offset: parseInt(offset),
    });

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { postLocation, getCurrentLocation, getHistory };
