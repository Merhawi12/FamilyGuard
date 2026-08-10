const { Contact } = require('../models');

/**
 * The device-facing view of a contact.
 *
 * Deliberately narrower than the parent's view: `notes` is the parent's private
 * annotation about the person ("Ada's teacher — call before 6"), and the device
 * never needs it to decide whether a caller is approved. Sending it would put
 * text the child was never meant to read on the child's phone.
 */
const toDeviceContact = (c) => ({
  id: c.id,
  name: c.name,
  phoneNumber: c.phoneNumber || null,
  email: c.email || null,
  relationship: c.relationship,
  updatedAt: c.updatedAt,
});

/**
 * The approved contacts for one child, as the device sees them.
 *
 * Only approved rows are returned, which is what makes removal and un-approval
 * behave identically on the device: both simply stop appearing in the list, and
 * a device that replaces its whole list ends up in the right state either way.
 */
const buildContactSync = async (childId) => {
  const contacts = await Contact.findAll({
    where: { childId, isApproved: true },
    order: [['name', 'ASC']],
  });

  return {
    contacts: contacts.map(toDeviceContact),
    syncedAt: new Date().toISOString(),
  };
};

/**
 * Tell a child's devices their approved list changed.
 *
 * Only a signal is pushed, never the list itself: the socket room is joined at
 * handshake time from the device token, but a device that was offline for the
 * event would miss a pushed payload entirely. Signalling instead means the
 * device re-reads the authoritative list over an authenticated request, and the
 * poll fallback in `rules.js` covers it if the signal never arrives.
 */
const notifyContactsChanged = (req, childId) => {
  const io = req.app.get('io');
  if (!io) return; // tests and scripts boot the app without a socket server
  io.to(`child:${childId}`).emit('contacts_updated', { childId });
};

module.exports = { toDeviceContact, buildContactSync, notifyContactsChanged };
