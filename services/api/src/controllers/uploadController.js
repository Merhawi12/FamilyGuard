const { Child } = require('../models');
const storage = require('../services/storage');
const { auditLog } = require('../utils/auditLogger');
const { isUuid } = require('../utils/ids');

/**
 * POST /api/uploads/child-avatar
 * Body: { childId, contentType, contentLength }
 *
 * Hands back a short-lived pre-signed Cloud Storage URL. The browser PUTs the image
 * directly to the bucket, then saves the returned `url` on the child record.
 */
const createChildAvatarUpload = async (req, res, next) => {
  try {
    const { childId, contentType, contentLength } = req.body;
    if (!childId || !contentType) return res.status(400).json({ error: 'childId and contentType are required' });

    // Ownership check before minting any credential. A malformed id is "not
    // found", not a database error — see utils/ids.js.
    const child = isUuid(childId)
      ? await Child.findOne({ where: { id: childId, parentId: req.user.id } })
      : null;
    if (!child) return res.status(404).json({ error: 'Child not found' });

    const upload = await storage.createImageUploadUrl({
      prefix: 'child-avatars',
      ownerId: req.user.id,
      contentType,
      contentLength,
    });

    auditLog(req, {
      userId: req.user.id,
      action: 'upload.child_avatar',
      entity: 'Child',
      entityId: childId,
      metadata: { key: upload.key },
    });

    res.json(upload);
  } catch (err) {
    next(err);
  }
};

module.exports = { createChildAvatarUpload };
