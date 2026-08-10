const jwt = require('jsonwebtoken');
const { User, Session, Device, Child } = require('../models');
const { env } = require('../config/env');
const { DEVICE_UNLINKED, ACCOUNT_SUSPENDED } = require('../utils/deviceAccess');

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.auth.jwtSecret);

    /**
     * The MFA pre-auth token is not a credential for anything but `/mfa/validate`.
     *
     * `signPreAuthToken` mints `{ id, mfaRequired: true }` after the *first*
     * factor only, and deliberately omits `sid` because no session exists yet.
     * That omission is exactly what let it through here: the session lookup
     * below is skipped when there is no `sid`, so the token fell straight to
     * `findByPk` and authenticated every route on this middleware for its full
     * five minutes. A password alone therefore reached children, locations,
     * messages and chat — MFA gated nothing but the shape of the login
     * response. Refused explicitly, before anything else looks at the claims.
     */
    if (decoded.mfaRequired) {
      return res.status(401).json({ error: 'Two-factor authentication is not complete' });
    }

    if (decoded.sid) {
      const session = await Session.findByPk(decoded.sid);
      if (!session || session.revoked) return res.status(401).json({ error: 'Session expired' });
      session.update({ lastActiveAt: new Date() }).catch(() => {});
      req.sessionId = session.id;
    }

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Used by child device — token contains { deviceId, childId } instead of { id }
const authenticateDevice = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.auth.jwtSecret);
    if (!decoded.deviceId || !decoded.childId) return res.status(401).json({ error: 'Invalid device token' });

    /**
     * A device is only as authorised as the family above it.
     *
     * This authenticated on `Device.isActive` alone, so a device outlived the
     * account it belonged to. Blocking a parent (`admin.toggleBlock`) revoked
     * their sessions and left every child device in the household fully
     * credentialed: it went on posting activity and **location**, reading its
     * rules, and reading and sending chat — collecting a blocked family's
     * children's whereabouts into a dashboard nobody could open. Deactivating a
     * child had the same shape on the child row.
     *
     * Checked here rather than by cascading `isActive` down on block, because
     * the chain is the truth and a cascade is a copy of it: unblocking restores
     * every device automatically, with no record of which ones were already off
     * to put back.
     *
     * The two refusals are deliberately different, and the difference is the
     * whole reason they are separate branches. A removed device is permanent —
     * the row is soft-deleted and there is no path that ever brings it back — so
     * the phone should stop, forget its token and offer to link again. A blocked
     * parent or a deactivated child is temporary and outside the child's
     * control, and a phone that wiped itself over it would need a fresh code
     * from an account that cannot sign in to issue one. The `code` field is what
     * lets the child app tell those apart; the prose is for anything reading
     * logs. Both are 401 because both mean "this credential does not work now".
     */
    const device = await Device.findByPk(decoded.deviceId, {
      include: [{
        model: Child,
        as: 'child',
        attributes: ['id', 'isActive', 'parentId'],
        include: [{ model: User, as: 'parent', attributes: ['id', 'isActive'] }],
      }],
    });
    if (!device || !device.isActive || !device.child) {
      return res.status(401).json({ error: 'This device is no longer linked', code: DEVICE_UNLINKED });
    }
    if (!device.child.isActive || !device.child.parent?.isActive) {
      return res.status(401).json({ error: 'Device access is suspended', code: ACCOUNT_SUSPENDED });
    }

    req.deviceId = decoded.deviceId;
    req.childId = decoded.childId;
    req.parentId = device.child.parentId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticate, authenticateDevice };
