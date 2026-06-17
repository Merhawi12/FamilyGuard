const { Contact, Child } = require('../models');

const resolveChild = (childId, parentId) =>
  Child.findOne({ where: { id: childId, parentId } });

// GET /api/contacts?childId=...
const getContacts = async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
};

// POST /api/contacts
const createContact = async (req, res) => {
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
    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/contacts/:id
const updateContact = async (req, res) => {
  try {
    const contact = await Contact.findOne({ where: { id: req.params.id, parentId: req.user.id } });
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
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/contacts/:id
const deleteContact = async (req, res) => {
  try {
    const contact = await Contact.findOne({ where: { id: req.params.id, parentId: req.user.id } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    await contact.destroy();
    res.json({ message: 'Contact deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getContacts, createContact, updateContact, deleteContact };
