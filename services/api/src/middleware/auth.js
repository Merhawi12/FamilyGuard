const jwt = require('jsonwebtoken');
const { User, Session, Device, Child } = require('../models');
const { env } = require('../config/env');
const { DEVICE_UNLINKED, ACCOUNT_SUSPENDED } = require('../utils/deviceAccess');
const { JWT_VERIFY_OPTIONS } = require('../utils/jwtOptions');

/**
 * How stale `Session.lastActiveAt` is allowed to get before it is written again.
 *
 * This was an unconditional `UPDATE sessions SET last_active_at = now()` on
 * **every authenticated request**. Opening the dashboard is a dozen calls, so a
 * parent moving between four screens issued something like fifty row writes to
 * record one fact that changes meaning on the scale of minutes — and every one
 * of them is a write to Cloud SQL, taken on the request's own connection, on the
 * hottest path in the service.
 *
 * A minute is chosen against what reads the column, which is only ever the two
 * "your active sessions" lists (Settings → Active sessions, and the console's
 * Sessions screen). Both order by it and print it as a human timestamp; neither
 * can tell sixty seconds of skew from none. Nothing authorises on it — session
 * validity is `revoked`, checked above and unaffected by this.
 *
 * Deliberately *not* a cache of the session row: the row is still read on every
 * request, so a revocation still takes effect on the next call. Only the write
 * is skipped.
 */
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

const touchSession = (session) => {
  const last = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
  // `Number.isNaN` rather than a truthiness check: an unparseable stored value
  // must be rewritten, not treated as infinitely fresh.
  if (!Number.isNaN(last) && Date.now() - last < SESSION_TOUCH_INTERVAL_MS) return;
  session.update({ lastActiveAt: new Date() }).catch(() => {});
};

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.auth.jwtSecret, JWT_VERIFY_OPTIONS);

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

    /**
     * Neither is a token minted for one narrow purpose.
     *
     * The same hole as the pre-auth token above, reopened by a different token.
     * `signTrustedDeviceToken` mints `{ id, purpose: 'trusted-device' }` — no
     * `sid`, because it names no session, and no `mfaRequired` — so it walked
     * past the guard above, skipped the session lookup below for want of a
     * `sid`, and authenticated every route on this middleware for a **thirty
     * day** expiry. That is the worst token in the service to hand out: it is
     * the one credential deliberately persisted in the browser, it is issued to
     * anybody who ticks "remember this device", and `logout`, *sign out other
     * devices* and `trustedDevicesRevokedAt` all leave it working, because only
     * `trustsDevice` consults any of them and nothing on this path calls it.
     * It bypassed both second factors outright — a trusted-device token never
     * goes through a sign-in at all.
     *
     * Refused on `purpose` rather than on the one value, so the next
     * purpose-scoped token is closed before it is written. A session token
     * carries no `purpose` claim; see utils/session.js.
     */
    if (decoded.purpose) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (decoded.sid) {
      const session = await Session.findByPk(decoded.sid);
      if (!session || session.revoked) return res.status(401).json({ error: 'Session expired' });
      touchSession(session);
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
    const decoded = jwt.verify(token, env.auth.jwtSecret, JWT_VERIFY_OPTIONS);
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
        // `name` is not needed to authorise anything. It is here because the
        // rules sync needs it and this row is already being fetched: the child
        // app greets whoever is holding the phone, so `GET /devices/me/rules`
        // was issuing a second `Child.findByPk` for one column, on the
        // highest-rate authenticated call on the platform. One extra column on a
        // query that already runs beats a query that does not have to.
        attributes: ['id', 'name', 'isActive', 'parentId'],
        include: [{ model: User, as: 'parent', attributes: ['id', 'isActive'] }],
      }],
    });
    if (!device || !device.isActive || !device.child) {
      return res.status(401).json({ error: 'This device is no longer linked', code: DEVICE_UNLINKED });
    }
    /**
     * The child in the token has to be the child on the device row.
     *
     * Both claims are signed, so today they always agree — `confirmLink` mints
     * them from one row. The check is here because the whole of this service's
     * child-scoping downstream reads `req.childId`, and it was being taken from
     * the token while every authorisation decision above it was made against the
     * device: `getDeviceRules`, `getDeviceContacts`, `postLocation`,
     * `receiveFromChild` and `getMyMessages` all trust it to name the child this
     * device belongs to. That is one signing-key mistake, one future
     * re-link-to-a-different-child feature, or one token minted by hand away
     * from being a cross-family read, and the device row is the authority for
     * the question in any case. Answered as an unlinked device, which is what a
     * token that does not describe a real pairing is.
     */
    if (device.childId !== device.child.id || decoded.childId !== device.childId) {
      return res.status(401).json({ error: 'This device is no longer linked', code: DEVICE_UNLINKED });
    }
    if (!device.child.isActive || !device.child.parent?.isActive) {
      return res.status(401).json({ error: 'Device access is suspended', code: ACCOUNT_SUSPENDED });
    }

    req.deviceId = device.id;
    // From the row, not the claim — see above.
    req.childId = device.childId;
    req.parentId = device.child.parentId;
    /**
     * The rows this check already loaded, offered to the handler behind it.
     *
     * Every device route re-derived what is sitting right here. `getDeviceRules`
     * in particular re-read the device (for `blockedAt`) and the child (for
     * `name`) that this query has just returned — two extra round trips per
     * device per five minutes, for ever, for two columns already in memory.
     *
     * The ids above stay the contract. This is an optimisation a handler may
     * take, not one it has to: `req.deviceId`/`req.childId` remain the only
     * things a route is required to trust, and they are still read off the row
     * rather than the token.
     */
    req.device = device;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticate, authenticateDevice, SESSION_TOUCH_INTERVAL_MS };
