const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { Device, Child, AppRule, WebsiteRule, ScreenTimeRule, ActivityLog } = require('../models');
const { generateLinkingCode } = require('../utils/crypto');
const { auditLog } = require('../utils/auditLogger');

const getDevices = async (req, res) => {
  const children = await Child.findAll({ where: { parentId: req.user.id }, attributes: ['id'] });
  const childIds = children.map((c) => c.id);
  const devices = await Device.findAll({ where: { childId: childIds, isActive: true }, include: ['child'] });
  res.json(devices);
};

const generateLink = async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
};

// Called from the child's device — unauthenticated, but requires both code AND deviceId to match.
const confirmLink = async (req, res) => {
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
      process.env.JWT_SECRET,
      { expiresIn: '365d' },
    );

    res.json({ device, deviceToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const removeDevice = async (req, res) => {
  const device = await Device.findByPk(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const child = await Child.findOne({ where: { id: device.childId, parentId: req.user.id } });
  if (!child) return res.status(403).json({ error: 'Forbidden' });

  await device.update({ isActive: false });
  auditLog(req, { userId: req.user.id, action: 'device.removed', entity: 'Device', entityId: device.id });
  res.json({ message: 'Device removed' });
};

// GET /api/devices/me/rules — device-authenticated, returns all active rules for this device's child
const getDeviceRules = async (req, res) => {
  try {
    const { childId } = req;
    const [appRules, websiteRules, screenTimeRule] = await Promise.all([
      AppRule.findAll({ where: { childId, isActive: true } }),
      WebsiteRule.findAll({ where: { childId, isActive: true } }),
      ScreenTimeRule.findOne({ where: { childId } }),
    ]);
    res.json({ appRules, websiteRules, screenTimeRule: screenTimeRule || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/devices/me/heartbeat — update lastSeen timestamp
const deviceHeartbeat = async (req, res) => {
  try {
    await Device.update({ lastSeen: new Date() }, { where: { id: req.deviceId } });
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/devices/me/activity — log app usage without requiring parent auth
const deviceLogActivity = async (req, res) => {
  try {
    const { appName, appPackage, category, startTime, endTime, durationMinutes, url } = req.body;
    const log = await ActivityLog.create({
      deviceId: req.deviceId,
      childId: req.childId,
      appName, appPackage, category, startTime, endTime, durationMinutes, url,
    });
    res.status(201).json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getDevices, generateLink, confirmLink, removeDevice, getDeviceRules, deviceHeartbeat, deviceLogActivity };
