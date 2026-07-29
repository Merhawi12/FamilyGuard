const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { Op } = require('sequelize');
const { Device, Child, AppRule, WebsiteRule, ScreenTimeRule, ActivityLog } = require('../models');
const { generateLinkingCode } = require('../utils/crypto');
const { auditLog } = require('../utils/auditLogger');
const { env } = require('../config/env');

const getDevices = async (req, res, next) => {
  try {
    const children = await Child.findAll({ where: { parentId: req.user.id }, attributes: ['id'] });
    const childIds = children.map((c) => c.id);
    const devices = await Device.findAll({ where: { childId: childIds, isActive: true }, include: ['child'] });
    res.json(devices);
  } catch (err) {
    next(err);
  }
};

const generateLink = async (req, res, next) => {
  try {
    const { childId, deviceName, type } = req.body;
    const child = await Child.findOne({ where: { id: childId, parentId: req.user.id } });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const code = generateLinkingCode();
    const expiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    const device = await Device.create({
      childId,
      name: deviceName || 'New Device',
      type: type || 'android',
      linkingCode: code,
      linkingCodeExpiry: expiry,
    });

    // Include deviceId in QR so confirmLink can cross-check both values
    const qrData = JSON.stringify({ code, deviceId: device.id });
    const qrCode = await QRCode.toDataURL(qrData);

    auditLog(req, { userId: req.user.id, action: 'device.link_generated', entity: 'Device', entityId: device.id, metadata: { childId, deviceName } });

    res.json({ device, code, qrCode });
  } catch (err) {
    next(err);
  }
};

// Called from the child's device — unauthenticated, but requires both code AND deviceId to match.
const confirmLink = async (req, res, next) => {
  try {
    const { code, deviceId, osVersion, pushToken } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });

    const device = await Device.findOne({ where: { linkingCode: code } });

    if (!device) return res.status(404).json({ error: 'Invalid linking code' });
    if (deviceId && device.id !== deviceId) return res.status(400).json({ error: 'Invalid linking code' });
    if (new Date() > device.linkingCodeExpiry) return res.status(400).json({ error: 'Code expired' });
    if (device.isLinked) return res.status(400).json({ error: 'Device already linked' });

    await device.update({ isLinked: true, osVersion, pushToken, lastSeen: new Date() });

    const deviceToken = jwt.sign(
      { deviceId: device.id, childId: device.childId },
      env.auth.jwtSecret,
      { expiresIn: '365d' },
    );

    res.json({ device, deviceToken });
  } catch (err) {
    next(err);
  }
};

const removeDevice = async (req, res, next) => {
  try {
    const device = await Device.findByPk(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const child = await Child.findOne({ where: { id: device.childId, parentId: req.user.id } });
    if (!child) return res.status(403).json({ error: 'Forbidden' });

    await device.update({ isActive: false });
    auditLog(req, { userId: req.user.id, action: 'device.removed', entity: 'Device', entityId: device.id });
    res.json({ message: 'Device removed' });
  } catch (err) {
    next(err);
  }
};

// GET /api/devices/me/rules — device-authenticated, returns all active rules for this device's child
const getDeviceRules = async (req, res, next) => {
  try {
    const { childId } = req;
    const [appRules, websiteRules, screenTimeRule] = await Promise.all([
      AppRule.findAll({ where: { childId } }),
      WebsiteRule.findAll({ where: { childId } }),
      ScreenTimeRule.findOne({ where: { childId } }),
    ]);
    res.json({ appRules, websiteRules, screenTimeRule: screenTimeRule || null });
  } catch (err) {
    next(err);
  }
};

// POST /api/devices/me/heartbeat — update lastSeen timestamp
const deviceHeartbeat = async (req, res, next) => {
  try {
    await Device.update({ lastSeen: new Date() }, { where: { id: req.deviceId } });
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
};

// POST /api/devices/me/activity — log app usage without requiring parent auth
// App-usage stats arrive as the running cumulative total for the day, so we
// upsert a single row per (child, app, day) instead of creating a duplicate
// on every sync cycle. Discrete events (web visits, other categories) are appended.
const deviceLogActivity = async (req, res, next) => {
  try {
    const { appName, appPackage, category, startTime, endTime, durationMinutes, url } = req.body;

    if (category === 'app_usage' && appPackage) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);

      const existing = await ActivityLog.findOne({
        where: {
          childId: req.childId,
          appPackage,
          category: 'app_usage',
          startTime: { [Op.gte]: dayStart },
        },
        order: [['startTime', 'ASC']],
      });

      if (existing) {
        // Client sends today's cumulative minutes — keep the max so a late/partial
        // sync can never shrink the recorded total.
        await existing.update({
          durationMinutes: Math.max(existing.durationMinutes || 0, durationMinutes || 0),
          endTime: endTime || new Date(),
          appName: appName || existing.appName,
          deviceId: req.deviceId,
        });
        return res.status(200).json(existing);
      }
    }

    const log = await ActivityLog.create({
      deviceId: req.deviceId,
      childId: req.childId,
      appName, appPackage, category, startTime: startTime || new Date(), endTime, durationMinutes, url,
    });
    res.status(201).json(log);
  } catch (err) {
    next(err);
  }
};

module.exports = { getDevices, generateLink, confirmLink, removeDevice, getDeviceRules, deviceHeartbeat, deviceLogActivity };
