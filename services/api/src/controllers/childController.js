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

    if (avatarUrl !== undefined) {
      if (!avatarUrl) {
        updates.avatarUrl = null;
      } else {
        // Only a URL this service issued to this parent may be stored. An
        // unchecked value would let a caller name someone else's object and
        // have the cleanup below delete it on the next update.
        const key = storage.ownedKeyFromUrl(avatarUrl, { prefix: 'child-avatars', ownerId: req.user.id });
        if (!key) return res.status(400).json({ error: 'avatarUrl must be an uploaded Parentix image' });
        updates.avatarUrl = avatarUrl;
      }
    }

    // Replacing or clearing a photo orphans the old object — clean it up. The
    // previous value came from this same validated path, so the key is ours.
    const previousUrl = child.avatarUrl;
    await child.update(updates);

    if (previousUrl && previousUrl !== child.avatarUrl) {
      const staleKey = storage.ownedKeyFromUrl(previousUrl, { prefix: 'child-avatars', ownerId: req.user.id });
      if (staleKey) storage.deleteObject(staleKey);
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
