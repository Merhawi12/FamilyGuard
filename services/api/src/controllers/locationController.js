const { Op } = require('sequelize');
const { Location, Child, Device, SafeZone } = require('../models');
const { createAlert } = require('../utils/alertHelper');
const { parsePagination } = require('../utils/pagination');
const { parseFix, INVALID_FIX } = require('../utils/geo');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const resolveChild = (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

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

/**
 * Persists a fix and fans out the consequences: push it to the parent's socket
 * and run the geofence transitions.
 *
 * `touchDevice` is only true for a report that really came from the device —
 * a position the parent typed in says nothing about whether the phone is alive,
 * so it must not refresh `lastSeen`.
 */
const recordLocation = async (req, { childId, deviceId, parentId, fix, touchDevice }) => {
  const { latitude, longitude, accuracy, speed, heading, address } = fix;

  const location = await Location.create({
    childId, deviceId, latitude, longitude, accuracy, speed, heading, address,
    // When the phone took the fix, where it credibly said so — a batch released
    // after a doze can be much older than its arrival. `parseFix` bounds the
    // claim; anything it will not vouch for falls back to now.
    recordedAt: fix.recordedAt || new Date(),
  });

  if (touchDevice) await Device.update({ lastSeen: new Date() }, { where: { id: deviceId } });

  const io = req.app.get('io');
  io.to(`parent:${parentId}`).emit('location:update', {
    childId, latitude, longitude, accuracy, speed, heading, address,
    recordedAt: location.recordedAt,
  });

  await checkGeofences(req, parentId, childId, latitude, longitude, io);

  return location;
};

// POST /api/locations  — called by child device (mobile app)
// Body: { latitude, longitude, accuracy?, speed?, heading?, address? }
const postLocation = async (req, res, next) => {
  try {
    // Identity comes from the authenticated device token (authenticateDevice),
    // NOT from the request body — prevents spoofing another child's location.
    const childId = req.childId;
    const deviceId = req.deviceId;
    const fix = parseFix(req.body);
    if (!fix) return res.status(400).json({ error: INVALID_FIX });

    const child = await Child.findByPk(childId, { attributes: ['parentId'] });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const location = await recordLocation(req, {
      childId,
      deviceId,
      parentId: child.parentId,
      fix,
      touchDevice: true,
    });

    res.status(201).json(location);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/locations/:childId/manual  — the parent sets the position by hand
 * from the dashboard ("use my location", or an address search).
 *
 * The device route above derives its identity from the device token so a phone
 * can only ever report its own position. A parent has no device token, so this
 * route authorises through child ownership instead.
 */
const setManualLocation = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const fix = parseFix(req.body);
    if (!fix) return res.status(400).json({ error: INVALID_FIX });

    // Every location belongs to a device, so there has to be one to attribute
    // the fix to.
    const device = await Device.findOne({
      where: { childId: child.id, isActive: true },
      order: [['createdAt', 'ASC']],
    });
    if (!device) {
      return res.status(400).json({ error: 'Link a device to this child before setting a location' });
    }

    const location = await recordLocation(req, {
      childId: child.id,
      deviceId: device.id,
      parentId: req.user.id,
      // A position typed in by a parent carries no motion, whatever was sent,
      // and is true as of now — it is a correction, not an observation the
      // phone made earlier, so it must not be backdated either.
      fix: { ...fix, speed: null, heading: null, recordedAt: null },
      touchDevice: false,
    });

    res.status(201).json(location);
  } catch (err) {
    next(err);
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
      await createAlert(io, { parentId, childId, type: 'entered_safe_zone', message: `Child arrived at ${zone.name}`, severity: 'medium', metadata: { zoneId: zone.id, zoneName: zone.name, lat, lng } });
    }

    if (justLeft && zone.notifyOnLeave) {
      await createAlert(io, { parentId, childId, type: 'left_safe_zone', message: `Child left ${zone.name}`, severity: 'high', metadata: { zoneId: zone.id, zoneName: zone.name, lat, lng } });
    }
  }
};

// GET /api/locations/:childId/current  — latest known position
const getCurrentLocation = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const location = await Location.findOne({
      where: { childId: child.id },
      order: [['recordedAt', 'DESC']],
      include: ['device'],
    });

    res.json(location || null);
  } catch (err) {
    next(err);
  }
};

// GET /api/locations/:childId/history  — paginated route history
const getHistory = async (req, res, next) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { limit, offset } = parsePagination(req.query, { max: 500, defaultLimit: 100 });
    const { from, to } = req.query;
    const where = { childId: child.id };
    if (from || to) {
      where.recordedAt = {};
      if (from) where.recordedAt[Op.gte] = new Date(from);
      if (to) where.recordedAt[Op.lte] = new Date(to);
    }

    const history = await Location.findAndCountAll({
      where,
      order: [['recordedAt', 'DESC']],
      limit,
      offset,
    });

    res.json(history);
  } catch (err) {
    next(err);
  }
};

module.exports = { postLocation, setManualLocation, getCurrentLocation, getHistory };
