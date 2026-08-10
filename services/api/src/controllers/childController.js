const { Child, Device, ScreenTimeRule } = require('../models');
const storage = require('../services/storage');
const { disconnectDeviceSockets } = require('../utils/session');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const findOwnChild = (id, parentId) =>
  (isUuid(id) ? Child.findOne({ where: { id, parentId } }) : null);

const getChildren = async (req, res, next) => {
  try {
    const children = await Child.findAll({
      where: { parentId: req.user.id, isActive: true },
      include: [
        // Removing a device is a soft delete — `isActive: false` — which every
        // other reader honours (GET /devices, the socket handshake, push
        // delivery). This include did not, so a removed device kept appearing
        // here and the delete button looked broken.
        //
        // `required: false` is load-bearing: without it Sequelize makes this an
        // INNER JOIN and a child with no devices drops out of the list entirely.
        { association: 'devices', where: { isActive: true }, required: false },
        { association: 'screenTimeRule' },
      ],
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
    const child = await findOwnChild(req.params.id, req.user.id);
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

/**
 * Removing a child takes its devices down with it.
 *
 * Deactivating only the child left every linked phone fully credentialed: the
 * device token authenticates against `Device.isActive` alone, so a child the
 * parent had removed carried on posting activity, web history and location
 * fixes indefinitely. The devices also went on counting against the account's
 * device allowance and still appeared in the device list, so a Free-plan parent
 * who removed a child could not link a replacement.
 */
const deleteChild = async (req, res, next) => {
  try {
    const child = await findOwnChild(req.params.id, req.user.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const devices = await Device.findAll({ where: { childId: child.id, isActive: true }, attributes: ['id'] });

    await child.update({ isActive: false });
    if (devices.length) {
      await Device.update({ isActive: false }, { where: { id: devices.map((d) => d.id) } });
      const io = req.app.get('io');
      for (const device of devices) disconnectDeviceSockets(io, device.id);
    }

    res.json({ message: 'Child removed' });
  } catch (err) {
    next(err);
  }
};

module.exports = { getChildren, createChild, updateChild, deleteChild };
