const { Child, ScreenTimeRule } = require('../models');
const storage = require('../services/storage');

const getChildren = async (req, res, next) => {
  try {
    const children = await Child.findAll({
      where: { parentId: req.user.id, isActive: true },
      include: [{ association: 'devices' }, { association: 'screenTimeRule' }],
    });
    res.json(children);
  } catch (err) {
    next(err);
  }
};

const createChild = async (req, res, next) => {
  try {
    const { name, age, avatar } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const child = await Child.create({ parentId: req.user.id, name, age, avatar });
    await ScreenTimeRule.create({ childId: child.id });
    res.status(201).json(child);
  } catch (err) {
    next(err);
  }
};

const updateChild = async (req, res, next) => {
  try {
    const child = await Child.findOne({ where: { id: req.params.id, parentId: req.user.id } });
    if (!child) return res.status(404).json({ error: 'Child not found' });

    // Whitelist updatable fields — never allow parentId/id/isActive reassignment via body
    const { name, age, avatar, avatarUrl } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (age !== undefined) updates.age = age;
    if (avatar !== undefined) updates.avatar = avatar;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl || null;

    // Replacing or clearing a photo orphans the old object — clean it up.
    const previousUrl = child.avatarUrl;
    await child.update(updates);
    if (previousUrl && previousUrl !== child.avatarUrl) {
      storage.deleteObject(storage.keyFromUrl(previousUrl));
    }

    res.json(child);
  } catch (err) {
    next(err);
  }
};

const deleteChild = async (req, res, next) => {
  try {
    const child = await Child.findOne({ where: { id: req.params.id, parentId: req.user.id } });
    if (!child) return res.status(404).json({ error: 'Child not found' });
    await child.update({ isActive: false });
    res.json({ message: 'Child removed' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getChildren, createChild, updateChild, deleteChild };
