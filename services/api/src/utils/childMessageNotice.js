/**
 * A message from a child has to reach the parent who is not looking.
 *
 * The parent→child direction has always pushed: `sendMessage` calls
 * `pushService.sendToChild`, because a message the child only sees if the app
 * happens to be open is not a message. The child→parent direction did not. It
 * emitted `chat:message` over the socket and stopped, and the socket only exists
 * while a dashboard is open in a browser — so a child asking for more screen
 * time, or saying they were staying late at school, produced nothing at all on a
 * parent's phone. Nothing else covered it either: the alert bell shows alerts
 * and platform announcements, not chat, so a parent who was not already on the
 * Messages page had no way to find out a message existed.
 *
 * The child app's own home screen offers this as a feature — "Need more time?
 * Send your parent a message and ask" — so the gap was worst in the case the
 * product invites.
 *
 * Two things it deliberately does not do:
 *
 * **It does not push for an emergency.** `emergency` already raises an
 * `emergency_button` alert, and `createAlert` pushes that with its own urgent
 * wording. A second notification a second later, quieter and about the same
 * event, would compete with the one that matters.
 *
 * **It does not fall back to email.** Chat is conversational, and a mailbox is
 * the wrong place for it; alerts are the channel that escalates.
 *
 * It does honour `pushAlerts`, the parent's one "interrupt me on my phone"
 * switch. Adding a channel a parent has no way to silence would be the worse
 * failure of the two, and Settings names this switch accordingly.
 */
const { Child, User } = require('../models');
const pushService = require('./pushService');
const logger = require('./logger');

/** Where tapping the notification should take the parent. */
const DESTINATION = '/dashboard/messages';

/** How much of a message to put in a notification body. */
const PREVIEW_LIMIT = 140;

const preview = (text) => {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  return clean.length > PREVIEW_LIMIT ? `${clean.slice(0, PREVIEW_LIMIT - 1)}…` : clean;
};

/**
 * `childName` is optional and looked up when it is missing, so a caller can hand
 * this straight to `track()` without first awaiting a query of its own. The
 * socket handler is why: awaiting the name inline would have delayed the
 * `chat:delivered` confirmation the child's phone is waiting on, and registering
 * the work *after* that confirmation left it outside anything that could wait
 * for it.
 *
 * @returns {Promise} resolves when the send settles; never rejects
 */
const notifyParentOfChildMessage = async ({ parentId, childName, text, messageType, messageId, childId }) => {
  // Covered by the alert pipeline, with better wording and a higher priority.
  if (messageType === 'emergency') return { sent: 0, failed: 0, recipients: 0, skipped: 'emergency' };

  try {
    const parent = await User.findByPk(parentId, { attributes: ['notificationPrefs'] });
    const prefs = parent?.notificationPrefs ? JSON.parse(parent.notificationPrefs) : {};
    // Defaults to on, like every other preference here: absent means unset, not off.
    if (prefs.pushAlerts === false) return { sent: 0, failed: 0, recipients: 0, skipped: 'muted' };

    const name = childName
      ?? (await Child.findByPk(childId, { attributes: ['name'] }))?.name;

    return await pushService.sendToUser(parentId, {
      title: messageType === 'check_in'
        ? `${name || 'Your child'} checked in`
        : `Message from ${name || 'your child'}`,
      body: preview(text),
      data: { type: 'chat', messageId, childId, url: DESTINATION },
    });
  } catch (err) {
    // A push service that is slow or down must never cost the message itself,
    // which is already stored and already on the socket.
    logger.error('Child message push failed', { error: err.message, messageId });
    return { sent: 0, failed: 0, recipients: 0 };
  }
};

module.exports = { notifyParentOfChildMessage, PREVIEW_LIMIT };
