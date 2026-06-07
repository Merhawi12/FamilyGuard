const QRCode = require('qrcode');
const { Device, Child } = require('../models');
const { generateLinkingCode } = require('../utils/crypto');

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

    const qrData = JSON.stringify({ code, deviceId: device.id });
    const qrCode = await QRCode.toDataURL(qrData);

    res.json({ device, code, qrCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const confirmLink = async (req, res) => {
  try {
    const { code, osVersion, pushToken } = req.body;
    const device = await Device.findOne({ where: { linkingCode: code } });

    if (!device) return res.status(404).json({ error: 'Invalid linking code' });
    if (new Date() > device.linkingCodeExpiry) return res.status(400).json({ error: 'Code expired' });

    await device.update({ isLinked: true, osVersion, pushToken, lastSeen: new Date() });
    res.json({ device });
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
  res.json({ message: 'Device removed' });
};

module.exports = { getDevices, generateLink, confirmLink, removeDevice };
