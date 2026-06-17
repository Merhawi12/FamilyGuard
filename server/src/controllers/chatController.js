const { Message, Child } = require('../models');
const { createAlert } = require('../utils/alertHelper');
const { detectCyberbullying } = require('../utils/cyberbullyingDetector');

// Verify the child belongs to the authenticated parent
const resolveChild = async (childId, parentId) =>
  Child.findOne({ where: { id: childId, parentId } });

// GET /api/chats/:childId/messages
const getMessages = async (req, res) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { limit = 50, offset = 0 } = req.query;
    const messages = await Message.findAndCountAll({
      where: { parentId: req.user.id, childId: child.id },
      order: [['createdAt', 'ASC']],
      limit: Math.min(parseInt(limit), 200),
      offset: parseInt(offset),
    });

    // Mark unread messages as read (for the parent side)
    await Message.update(
      { isRead: true },
      { where: { parentId: req.user.id, childId: child.id, senderRole: 'child', isRead: false } }
    );

    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/chats/:childId/messages  { text, messageType? }
// Sends a message from the parent to the child
const sendMessage = async (req, res) => {
  try {
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const { text, messageType = 'normal' } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

    const message = await Message.create({
      parentId: req.user.id,
      childId: child.id,
      senderId: req.user.id,
      senderRole: 'parent',
      text: text.trim(),
      messageType,
    });

    // Push to child's device via socket
    const io = req.app.get('io');
    io.to(`child:${child.id}`).emit('chat:message', message);

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/chats/:childId/messages/from-child  { text, messageType?, childDeviceToken }
// Called by the mobile app — no parent auth, identified by childId + deviceId pairing
const receiveFromChild = async (req, res) => {
  try {
    const { childId } = req.params;
    const { text, messageType = 'normal', deviceId } = req.body;
    if (!text?.trim() || !deviceId) return res.status(400).json({ error: 'text and deviceId are required' });

    const child = await Child.findByPk(childId, { attributes: ['id', 'parentId'] });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const message = await Message.create({
      parentId: child.parentId,
      childId: child.id,
      senderId: child.id,
      senderRole: 'child',
      text: text.trim(),
      messageType,
    });

    const io = req.app.get('io');

    if (messageType === 'emergency') {
      await createAlert(io, { parentId: child.parentId, childId: child.id, type: 'emergency_button', message: `Emergency alert from child: ${text.trim()}`, severity: 'high', metadata: { messageId: message.id, deviceId } });
    }

    const { detected, matchedKeywords } = detectCyberbullying(text.trim());
    if (detected) {
      await createAlert(io, { parentId: child.parentId, childId: child.id, type: 'cyberbullying', message: `Possible cyberbullying detected in child message`, severity: 'high', metadata: { messageId: message.id, matchedKeywords } });
    }

    io.to(`parent:${child.parentId}`).emit('chat:message', message);
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getMessages, sendMessage, receiveFromChild };
