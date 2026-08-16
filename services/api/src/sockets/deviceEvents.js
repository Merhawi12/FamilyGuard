const { Device, Message, Child } = require('../models');
const { createAlert } = require('../utils/alertHelper');
const { detectCyberbullying } = require('../utils/cyberbullyingDetector');
const { parseFix } = require('../utils/geo');
const { notifyParentOfChildMessage } = require('../utils/childMessageNotice');
const { track } = require('../utils/background');
const logger = require('../utils/logger');

// NOTE: socket.data is populated by the io.use() handshake-auth middleware in app.js.
// It is the ONLY trusted source of identity — client-supplied ids are ignored.
const initSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    const { role, parentId, childId, deviceId } = socket.data;

    // ── Auto-join the authenticated room(s) ──────────────────────────────────
    // A parent joins its own parent room; a child device joins its child room.
    //
    // The role check on the parent room is load-bearing. A child socket also
    // carries `parentId` — it is how the device's own events are routed to the
    // family — so joining on that field alone put every child's phone in the
    // room that receives `alert:new`, `location:update`, `activity:update` and
    // `chat:message` for the whole household. A child could see a sibling's
    // location and every alert raised about them. Nothing the child app
    // subscribes to is delivered there: rules, contacts, screen time and its own
    // chat thread all arrive on `child:<childId>`.
    if (role === 'parent' && parentId) socket.join(`parent:${parentId}`);
    if (role === 'child' && childId) {
      socket.join(`child:${childId}`);
      if (deviceId) socket.join(`device:${deviceId}`);
    }

    // Legacy join events are kept as no-ops for backward compatibility, but they
    // never trust the supplied id — membership is fixed at authentication time.
    socket.on('join:parent', () => { if (role === 'parent' && parentId) socket.join(`parent:${parentId}`); });
    socket.on('join:child', () => { if (role === 'child' && childId) socket.join(`child:${childId}`); });

    // ── Device heartbeat (child only) ────────────────────────────────────────
    socket.on('device:heartbeat', async () => {
      if (role !== 'child' || !deviceId) return;
      await Device.update({ lastSeen: new Date() }, { where: { id: deviceId } });
      socket.broadcast.to(`device:${deviceId}`).emit('device:online', { deviceId });
    });

    // ── Alert types (emitted by the child device) ────────────────────────────
    socket.on('alert:blocked_app', async ({ appName }) => {
      if (role !== 'child') return;
      await createAlert(io, { parentId, childId, deviceId, type: 'blocked_app_attempt', message: `${appName} was blocked on a child device`, severity: 'medium' });
    });

    socket.on('alert:screen_time_exceeded', async () => {
      if (role !== 'child') return;
      await createAlert(io, { parentId, childId, deviceId, type: 'screen_time_exceeded', message: 'Daily screen time limit has been reached', severity: 'high' });
    });

    /*
     * An app this phone has not seen the child open before.
     *
     * The device works this out from its own usage sync rather than from a
     * PACKAGE_ADDED receiver — see the child app's services/newApps.js for why
     * that is both simpler and the better question. The message says "used"
     * rather than "installed" because that is what was observed.
     */
    socket.on('alert:app_installed', async ({ appName, appPackage }) => {
      if (role !== 'child') return;
      await createAlert(io, { parentId, childId, deviceId, type: 'app_installed', message: `${appName} was opened for the first time on a child device`, severity: 'medium', metadata: { appName, appPackage } });
    });

    /*
     * `alert:dangerous_content` is raised by the server now, not the device —
     * see utils/riskyBrowsing.js. The phone reports the domains it resolves and
     * the API knows which categories those belong to, which is the whole of what
     * a DNS-level filter can honestly claim. There is nothing for the device to
     * emit, so there is no handler for it to emit to.
     */

    /*
     * There is no `alert:unknown_contact` handler, and that is a decision.
     *
     * Matching a caller against the parent's approved list needs the number, and
     * on Android 9+ that means READ_CALL_LOG (and RECEIVE_SMS for texts) — both
     * on Google Play's restricted-permissions list, both requiring a declared
     * and reviewed use case, on a product that has deliberately kept its
     * permission set narrow enough to explain to a parent. Parentix is not going
     * to ask a family for their child's call log.
     *
     * The handler used to exist and no device has ever emitted to it. Keeping a
     * listener for an event nothing sends made the capability look present in
     * every reading of this file. The approved-contact list itself stays and is
     * still synced — it is the parent's record of who is in their child's life,
     * and the child app now shows it to the child — but nothing claims it is
     * enforced. See config/alertTypes.js.
     */

    // ── Activity stream (child only → its own parent) ────────────────────────
    socket.on('activity:update', ({ data }) => {
      if (role !== 'child' || !parentId) return;
      io.to(`parent:${parentId}`).emit('activity:update', data);
    });

    // ── Real-time location (child only → its own parent) ─────────────────────
    // Mobile emits this for low-latency updates; the REST POST handles persistence.
    socket.on('location:update', (payload) => {
      if (role !== 'child' || !parentId) return;
      // Same validation the REST route applies. This path skips the database
      // entirely, so without it an unplottable fix would go straight to the
      // parent's live map — and being the faster of the two, it is the one that
      // wins the race to be displayed.
      const fix = parseFix(payload);
      if (!fix) return;
      io.to(`parent:${parentId}`).emit('location:update', {
        childId, ...fix,
        // `parseFix` has already refused a timestamp it cannot vouch for, so
        // this no longer forwards whatever the payload claimed. The live map
        // sorts by it, and a fix stamped an hour ahead would sit at the top of
        // it until the clock caught up.
        recordedAt: (fix.recordedAt || new Date()).toISOString(),
      });
    });

    // ── Family chat ──────────────────────────────────────────────────────────

    // Child sends a message via socket (in addition to the REST endpoint)
    socket.on('chat:send', async ({ text, messageType = 'normal' }) => {
      if (role !== 'child' || !childId) return;
      try {
        const message = await Message.create({
          parentId,
          childId,
          senderId: childId,
          senderRole: 'child',
          text: text?.trim(),
          messageType,
        });

        // Deliver to parent
        io.to(`parent:${parentId}`).emit('chat:message', message);

        /**
         * And to the parent's phone, which is where they actually are.
         *
         * This is the path the child app prefers whenever its socket is up, so
         * without the same push the REST route sends, the *better-connected* the
         * child's phone was the less likely their parent was to hear about the
         * message at all. See utils/childMessageNotice.js — it looks the child's
         * name up itself, so registering this costs no await and does not stand
         * between the child and their delivery confirmation.
         */
        track(notifyParentOfChildMessage({
          parentId,
          childId,
          text: message.text,
          messageType,
          messageId: message.id,
        }));

        // Confirm delivery back to sender
        socket.emit('chat:delivered', { messageId: message.id });

        if (messageType === 'emergency') {
          await createAlert(io, { parentId, childId, type: 'emergency_button', message: `Emergency alert from child: ${text?.trim()}`, severity: 'high', metadata: { messageId: message.id, deviceId } });
        }

        const { detected, matchedKeywords } = detectCyberbullying(text?.trim());
        if (detected) {
          await createAlert(io, { parentId, childId, type: 'cyberbullying', message: 'Possible cyberbullying detected in child message', severity: 'high', metadata: { messageId: message.id, matchedKeywords } });
        }
      } catch (err) {
        logger.error('socket chat:send failed', { error: err.message });
      }
    });

    // Parent sends a message via socket (mirrors the REST endpoint)
    socket.on('chat:reply', async ({ childId: targetChildId, text, messageType = 'normal' }) => {
      if (role !== 'parent') return;
      try {
        // Verify the target child belongs to this authenticated parent
        const child = await Child.findOne({ where: { id: targetChildId, parentId }, attributes: ['id'] });
        if (!child) return;

        const message = await Message.create({
          parentId,
          childId: child.id,
          senderId: parentId,
          senderRole: 'parent',
          text: text?.trim(),
          messageType,
        });

        io.to(`child:${child.id}`).emit('chat:message', message);
        socket.emit('chat:delivered', { messageId: message.id });
      } catch (err) {
        logger.error('socket chat:reply failed', { error: err.message });
      }
    });
  });
};

module.exports = initSocketHandlers;
