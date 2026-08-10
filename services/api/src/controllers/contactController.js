const { Contact, Child } = require('../models');
const { notifyContactsChanged } = require('../utils/contactSync');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const resolveChild = (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

const findOwnContact = (id, parentId) =>
  (isUuid(id) ? Contact.findOne({ where: { id, parentId } }) : null);

// GET /api/contacts?childId=...
const getContacts = async (req, res, next) => {
  try {
    const { childId } = req.query;
    const where = { parentId: req.user.id };
    if (childId) {
      const child = await resolveChild(childId, req.user.id);
      if (!child) return res.status(404).json({ error: 'Child not found' });
      where.childId = childId;
    }
    const contacts = await Contact.findAll({ where, order: [['name', 'ASC']] });
    res.json(contacts);
  } catch (err) {
    next(err);
  }
};

// POST /api/contacts
const createContact = async (req, res, next) => {
  try {
    const { childId, name, phoneNumber, email, relationship, notes } = req.body;
    if (!childId || !name) return res.status(400).json({ error: 'childId and name are required' });

    const child = await resolveChild(childId, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const contact = await Contact.create({
      parentId: req.user.id,
      childId,
      name: name.trim(),
      phoneNumber: phoneNumber?.trim(),
      email: email?.trim(),
      relationship: relationship || 'other',
      notes: notes?.trim(),
    });

    notifyContactsChanged(req, childId);
    res.status(201).json(contact);
  } catch (err) {
    next(err);
  }
};

// PUT /api/contacts/:id
const updateContact = async (req, res, next) => {
  try {
    const contact = await findOwnContact(req.params.id, req.user.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const { name, phoneNumber, email, relationship, isApproved, notes } = req.body;
    await contact.update({
      ...(name !== undefined && { name: name.trim() }),
      ...(phoneNumber !== undefined && { phoneNumber: phoneNumber.trim() }),
      ...(email !== undefined && { email: email.trim() }),
      ...(relationship !== undefined && { relationship }),
      ...(isApproved !== undefined && { isApproved }),
      ...(notes !== undefined && { notes: notes.trim() }),
    });

    // Any edit is pushed, not just an approval change: a corrected phone number
    // has to reach the device too, or it keeps matching on the stale one.
    notifyContactsChanged(req, contact.childId);
    res.json(contact);
  } catch (err) {
    next(err);
  }
};

// DELETE /api/contacts/:id
const deleteContact = async (req, res, next) => {
  try {
    const contact = await findOwnContact(req.params.id, req.user.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Captured before the row goes away — the child room to signal is derived
    // from it, and after destroy() the association is gone.
    const { childId } = contact;
    await contact.destroy();

    notifyContactsChanged(req, childId);
    res.json({ message: 'Contact deleted' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getContacts, createContact, updateContact, deleteContact };
