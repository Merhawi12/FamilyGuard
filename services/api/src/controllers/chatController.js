const { Message, Child } = require('../models');
const { createAlert } = require('../utils/alertHelper');
const { detectCyberbullying } = require('../utils/cyberbullyingDetector');
const { parsePagination } = require('../utils/pagination');
// Called through the module rather than destructured so the send stays
// interceptable from the tests.
const pushService = require('../utils/pushService');
const { track } = require('../utils/background');
const { notifyParentOfChildMessage } = require('../utils/childMessageNotice');
const { isUuid } = require('../utils/ids');

// Verify the child belongs to the authenticated parent. A malformed id is "not
// found", not a database error — see utils/ids.js for why this has to be checked
// before the query rather than after it.
const resolveChild = async (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

// GET /api/chats/:childId/messages
const getMessages = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const child = await resolveChild(req.params.childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const messages = await Message.findAndCountAll({
      where: { parentId: req.user.id, childId: child.id },
      order: [['createdAt', 'ASC']],
      limit,
      offset,
    });

    // Mark unread messages as read (for the parent side)
    await Message.update(
      { isRead: true },
      { where: { parentId: req.user.id, childId: child.id, senderRole: 'child', isRead: false } }
    );

    res.json(messages);
  } catch (err) {
    next(err);
  }
};

// POST /api/chats/:childId/messages  { text, messageType? }
// Sends a message from the parent to the child
const sendMessage = async (req, res, next) => {
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

    // And as a notification, which is what reaches the child when the app is in
    // the background or closed and the socket is not connected. Not awaited: the
    // message is already saved and delivered to anything listening.
    track(
      pushService.sendToChild(child.id, {
        title: messageType === 'emergency' ? 'Urgent message from your parent' : 'Message from your parent',
        body: text.trim(),
        data: { type: 'chat', messageId: message.id, screen: 'Messages' },
      })
    );

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
};

// POST /api/chats/:childId/messages/from-child  { text, messageType?, childDeviceToken }
// Called by the mobile app — no parent auth, identified by childId + deviceId pairing
const receiveFromChild = async (req, res, next) => {
  try {
    // Identity comes from the authenticated device token (authenticateDevice).
    const childId = req.childId;
    const deviceId = req.deviceId;
    const { text, messageType = 'normal' } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

    const child = await Child.findByPk(childId, { attributes: ['id', 'parentId', 'name'] });
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

    /**
     * The socket only reaches a dashboard that is open. Without this a child's
     * message produced nothing at all on a parent's phone — see
     * utils/childMessageNotice.js. Tracked rather than awaited: the message is
     * stored and delivered already, and a slow push service must not hold up the
     * device's request.
     */
    track(notifyParentOfChildMessage({
      parentId: child.parentId,
      childId: child.id,
      childName: child.name,
      text: message.text,
      messageType,
      messageId: message.id,
    }));

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chats/me/messages — the child device reads its own thread.
 *
 * The parent-facing `GET /:childId/messages` needs a parent session, so without
 * this the child app could send messages but never see the conversation. The
 * child is taken from the device token, so there is no id to tamper with.
 */
const getMyMessages = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const child = await Child.findByPk(req.childId, { attributes: ['id', 'parentId'] });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const messages = await Message.findAndCountAll({
      where: { parentId: child.parentId, childId: child.id },
      order: [['createdAt', 'ASC']],
      limit,
      offset,
    });

    // Mirror of the parent side: opening the thread clears the unread flag on
    // the messages the other party sent.
    await Message.update(
      { isRead: true },
      { where: { parentId: child.parentId, childId: child.id, senderRole: 'parent', isRead: false } }
    );

    res.json(messages);
  } catch (err) {
    next(err);
  }
};

module.exports = { getMessages, sendMessage, receiveFromChild, getMyMessages };
